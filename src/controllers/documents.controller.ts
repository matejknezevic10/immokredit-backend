// src/controllers/documents.controller.ts
import { Request, Response } from 'express';
import { PrismaClient, AmpelStatus, Temperatur } from '@prisma/client';
import { analyzeDocument, DOCUMENT_SCHEMAS } from '../services/ocr.service';
import { matchCustomer } from '../services/customerMatching.service';
import { processIncomingEmail } from '../services/documentProcessor.service';
import { sendToN8n } from '../services/n8nWebhook.service';
import { processDocumentInPipedrive } from '../services/pipedrive.service';
import { createCustomerFolder, uploadFileToCustomerFolder } from '../services/googleDrive.service';

const prisma = new PrismaClient();

// ============================================================
// Email-based serialization lock to prevent race conditions
// When 2 attachments arrive from the same email simultaneously,
// this ensures they are processed sequentially (not in parallel)
// so the second one finds the lead created by the first one.
// ============================================================
const emailProcessingLocks = new Map<string, Promise<void>>();

async function withEmailLock<T>(emailKey: string, fn: () => Promise<T>): Promise<T> {
  // Wait for any pending request from the same sender
  while (emailProcessingLocks.has(emailKey)) {
    await emailProcessingLocks.get(emailKey);
  }

  // Create a lock for this request
  let releaseLock: () => void;
  const lockPromise = new Promise<void>(resolve => { releaseLock = resolve; });
  emailProcessingLocks.set(emailKey, lockPromise);

  try {
    return await fn();
  } finally {
    emailProcessingLocks.delete(emailKey);
    releaseLock!();
  }
}

// ============================================================
// Helper: Auto-create Lead from OCR data + Email
// ============================================================
async function autoCreateLead(
  emailFrom: string,
  personenNamen: string[],
  extractedFields: Record<string, { value: string | number | null; confidence: number }>,
  rootFolderId?: string,
): Promise<{ leadId: string; leadName: string }> {

  let firstName = '';
  let lastName = '';

  // Priority 1: vorname + nachname from OCR
  if (extractedFields.vorname?.value && extractedFields.nachname?.value) {
    firstName = String(extractedFields.vorname.value).trim();
    lastName = String(extractedFields.nachname.value).trim();
  }

  // Priority 2: personenNamen from OCR
  if (!firstName && personenNamen.length > 0) {
    const fullName = personenNamen[0];
    const parts = fullName.trim().split(/\s+/);
    if (parts.length >= 2) {
      firstName = parts[0];
      lastName = parts.slice(1).join(' ');
    } else {
      firstName = fullName;
    }
  }

  // Priority 3: Other name fields
  if (!firstName) {
    const nameFields = ['arbeitnehmer_name', 'kontoinhaber', 'kaeufer_name', 'eigentuemer', 'inhaber_name'];
    for (const field of nameFields) {
      if (extractedFields[field]?.value) {
        const parts = String(extractedFields[field].value).trim().split(/\s+/);
        if (parts.length >= 2) {
          firstName = parts[0];
          lastName = parts.slice(1).join(' ');
          break;
        }
      }
    }
  }

  // Priority 4: Email prefix
  if (!firstName) {
    const emailPrefix = emailFrom.split('@')[0];
    const parts = emailPrefix.replace(/[._-]/g, ' ').split(/\s+/);
    firstName = parts[0] || 'Unbekannt';
    lastName = parts.slice(1).join(' ') || 'Unbekannt';
  }

  firstName = firstName.charAt(0).toUpperCase() + firstName.slice(1);
  if (lastName) lastName = lastName.charAt(0).toUpperCase() + lastName.slice(1);
  if (!lastName) lastName = 'Unbekannt';

  console.log(`[AutoLead] Creating: ${firstName} ${lastName} (${emailFrom})`);

  const lead = await prisma.lead.create({
    data: {
      firstName,
      lastName,
      email: emailFrom,
      phone: '',
      source: 'EMAIL',
      ampelStatus: AmpelStatus.YELLOW,
      temperatur: Temperatur.WARM,
      score: 0,
    },
  });

  await prisma.activity.create({
    data: {
      leadId: lead.id,
      type: 'LEAD_CREATED',
      title: 'Lead automatisch erstellt',
      description: `Lead wurde automatisch aus Email von ${emailFrom} erstellt`,
    },
  });

  // Create Google Drive folder
  try {
    const { folderId, folderUrl } = await createCustomerFolder(firstName, lastName, rootFolderId);
    await prisma.lead.update({
      where: { id: lead.id },
      data: { googleDriveFolderId: folderId, googleDriveFolderUrl: folderUrl },
    });
    console.log(`[AutoLead] ✅ Lead + Drive folder: ${firstName} ${lastName} → ${folderUrl}`);
  } catch (err: any) {
    console.error(`[AutoLead] ⚠️ Drive folder failed: ${err.message}`);
  }

  return { leadId: lead.id, leadName: `${firstName} ${lastName}` };
}

// ============================================================
// Helper: Ensure lead has Google Drive folder, create if missing
// ============================================================
async function ensureDriveFolder(leadId: string, rootFolderId?: string): Promise<void> {
  // Re-fetch the lead to get the LATEST data (important after autoCreateLead)
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead || lead.googleDriveFolderId) return; // Already has folder → skip

  try {
    const { folderId, folderUrl } = await createCustomerFolder(lead.firstName, lead.lastName, rootFolderId);
    await prisma.lead.update({
      where: { id: lead.id },
      data: { googleDriveFolderId: folderId, googleDriveFolderUrl: folderUrl },
    });
    console.log(`[GDrive] Created missing folder for ${lead.firstName} ${lead.lastName}`);
  } catch (err: any) {
    console.error(`[GDrive] ⚠️ Folder creation failed: ${err.message}`);
  }
}

// ============================================================
// Helper: Capitalize name properly (Mix-Case)
// ============================================================
function capitalizeName(name: string): string {
  if (!name) return name;
  return name
    .split(/(\s+|-)/g)
    .map(part => {
      if (part.match(/^[\s-]+$/)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join('');
}

// ============================================================
// Document type label mapping for filenames
// ============================================================
const DOC_TYPE_LABELS: Record<string, string> = {
  GEHALTSABRECHNUNG: 'Lohnzettel',
  REISEPASS: 'Reisepass',
  AUSWEIS: 'Ausweis',
  KONTOAUSZUG: 'Kontoauszug',
  KAUFVERTRAG: 'Kaufvertrag',
  GRUNDBUCHAUSZUG: 'Grundbuchauszug',
  SONSTIGES: 'Dokument',
};

// ============================================================
// Helper: Upload file to customer's Google Drive folder
// ============================================================
async function uploadToCustomerDrive(
  fileBuffer: Buffer,
  filename: string,
  mimeType: string,
  leadId: string | null | undefined,
  documentId: string,
  documentType?: string,
) {
  if (!leadId) return;

  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead?.googleDriveFolderId) {
      console.log(`[GDrive] Lead ${leadId} has no folder — skipping upload`);
      return;
    }

    // Mix-Case name for filename: "MATEJ KNEŽEVIĆ" → "Matej Knežević"
    const customerName = `${capitalizeName(lead.firstName)} ${capitalizeName(lead.lastName)}`.trim();

    // Map document type to readable label
    const docLabel = documentType ? (DOC_TYPE_LABELS[documentType] || documentType) : undefined;

    const result = await uploadFileToCustomerFolder(
      fileBuffer,
      filename,
      mimeType,
      lead.googleDriveFolderId,
      docLabel,        // e.g. "Lohnzettel", "Reisepass"
      customerName,    // e.g. "Matej Knežević"
    );

    await prisma.document.update({
      where: { id: documentId },
      data: {
        googleDriveId: result.fileId,
        googleDriveUrl: result.webViewLink,
      },
    });

    console.log(`[GDrive] ✅ ${filename} → ${lead.firstName} ${lead.lastName} folder`);
  } catch (err: any) {
    console.error(`[GDrive] ⚠️ Upload failed: ${err.message}`);
  }
}

class DocumentsController {
  // ============================================================
  // GET /api/documents - List all documents
  // ============================================================
  async getAll(req: Request, res: Response) {
    try {
      const {
        page = '1',
        limit = '20',
        status,
        type,
        leadId,
        unassigned,
      } = req.query;

      const pageNum = parseInt(page as string);
      const limitNum = parseInt(limit as string);
      const skip = (pageNum - 1) * limitNum;

      const where: any = {};
      if (status) where.ocrStatus = status;
      if (type) where.type = type;
      if (leadId) where.leadId = leadId;
      if (unassigned === 'true') where.leadId = null;

      const [documents, total] = await Promise.all([
        prisma.document.findMany({
          where,
          include: {
            lead: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
          },
          orderBy: { uploadedAt: 'desc' },
          skip,
          take: limitNum,
        }),
        prisma.document.count({ where }),
      ]);

      const mapped = documents.map((doc) => ({
        id: doc.id,
        customer_id: doc.leadId,
        email_from: doc.emailFrom,
        email_subject: doc.emailSubject,
        email_received_at: doc.emailReceivedAt,
        email_message_id: doc.emailMessageId,
        filename: doc.originalFilename || doc.filename,
        file_type: doc.mimeType,
        file_size: doc.size,
        document_type: doc.type.toLowerCase(),
        ocr_status: doc.ocrStatus.toLowerCase(),
        ocr_error: doc.ocrError,
        ocr_processed_at: doc.ocrProcessedAt,
        assignment_method: doc.assignmentMethod.toLowerCase(),
        assignment_confidence: doc.assignmentConfidence,
        customer_first_name: doc.lead?.firstName,
        customer_last_name: doc.lead?.lastName,
        customer_email: doc.lead?.email,
        ocr_data: doc.extractedData,
        google_drive_url: doc.googleDriveUrl,
        created_at: doc.uploadedAt,
        updated_at: doc.uploadedAt,
      }));

      res.json({
        documents: mapped,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (err: any) {
      console.error('[Documents] Error fetching:', err);
      res.status(500).json({ error: err.message });
    }
  }

  // ============================================================
  // GET /api/documents/:id
  // ============================================================
  async getById(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const doc = await prisma.document.findUnique({
        where: { id },
        include: {
          lead: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      });

      if (!doc) {
        return res.status(404).json({ error: 'Document not found' });
      }

      const ocrResults = doc.extractedData
        ? Object.entries(doc.extractedData as Record<string, any>).map(
            ([fieldName, fieldData]) => ({
              field_name: fieldName,
              field_value: String(fieldData?.value ?? ''),
              field_type: typeof fieldData?.value === 'number' ? 'currency' : 'text',
              confidence: fieldData?.confidence || 0,
            })
          )
        : [];

      res.json({
        document: {
          ...doc,
          customer_id: doc.leadId,
          customer_first_name: doc.lead?.firstName,
          customer_last_name: doc.lead?.lastName,
          customer_email: doc.lead?.email,
          document_type: doc.type.toLowerCase(),
          ocr_status: doc.ocrStatus.toLowerCase(),
          file_type: doc.mimeType,
          file_size: doc.size,
          email_from: doc.emailFrom,
          email_subject: doc.emailSubject,
          email_received_at: doc.emailReceivedAt,
          assignment_method: doc.assignmentMethod.toLowerCase(),
          assignment_confidence: doc.assignmentConfidence,
          ocr_processed_at: doc.ocrProcessedAt,
          ocr_error: doc.ocrError,
          google_drive_url: doc.googleDriveUrl,
          created_at: doc.uploadedAt,
        },
        ocr_results: ocrResults,
      });
    } catch (err: any) {
      console.error('[Documents] Error fetching document:', err);
      res.status(500).json({ error: err.message });
    }
  }

  // ============================================================
  // PATCH /api/documents/:id/assign
  // ============================================================
  async assign(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { customer_id } = req.body;

      const doc = await prisma.document.update({
        where: { id },
        data: {
          leadId: customer_id,
          assignmentMethod: 'MANUAL',
          assignmentConfidence: 1.0,
        },
      });

      res.json({ document: doc });
    } catch (err: any) {
      console.error('[Documents] Error assigning:', err);
      res.status(500).json({ error: err.message });
    }
  }

  // ============================================================
  // PATCH /api/documents/:id/extracted-data
  // ============================================================
  async updateExtractedData(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { extractedData } = req.body;

      if (!extractedData || typeof extractedData !== 'object') {
        return res.status(400).json({ error: 'extractedData object required' });
      }

      const doc = await prisma.document.update({
        where: { id },
        data: { extractedData: extractedData as any },
      });

      console.log(`[Documents] Updated extracted data for ${id}`);
      res.json({ success: true, document: doc });
    } catch (err: any) {
      console.error('[Documents] Error updating extracted data:', err);
      res.status(500).json({ error: err.message });
    }
  }

  // ============================================================
  // POST /api/documents/upload - Manual file upload with OCR
  // ============================================================
  async upload(req: Request, res: Response) {
    try {
      const files = req.files as Express.Multer.File[];
      const { customer_id } = req.body;

      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const results = [];

      for (const file of files) {
        try {
          const ocrResult = await analyzeDocument(file.buffer, file.mimetype, file.originalname);

          const customerMatch = customer_id
            ? { leadId: customer_id, leadName: null, method: 'MANUAL' as const, confidence: 1.0 }
            : await matchCustomer(null, ocrResult.personenNamen, ocrResult.fields);

          const doc = await prisma.document.create({
            data: {
              leadId: customerMatch.leadId || customer_id || undefined,
              filename: file.originalname,
              originalFilename: file.originalname,
              type: (ocrResult.prismaType as any) || 'SONSTIGES',
              mimeType: file.mimetype,
              size: file.size,
              extractedData: ocrResult.fields as any,
              ocrStatus: 'COMPLETED',
              ocrProcessedAt: new Date(),
              ocrConfidence: ocrResult.overallConfidence,
              assignmentMethod: customer_id ? 'MANUAL' : (customerMatch.method as any),
              assignmentConfidence: customer_id ? 1.0 : customerMatch.confidence,
            },
          });

          // Google Drive Upload (await to ensure sequential numbering)
          const assignedLeadId = customerMatch.leadId || customer_id;
          if (assignedLeadId) {
            await ensureDriveFolder(assignedLeadId);
            try {
              await uploadToCustomerDrive(file.buffer, file.originalname, file.mimetype, assignedLeadId, doc.id, ocrResult.prismaType);
            } catch (err: any) {
              console.error(`[Documents] GDrive failed: ${err.message}`);
            }
          }

          // Pipedrive
          processDocumentInPipedrive({
            documentId: doc.id,
            documentType: ocrResult.documentType,
            documentTypeLabel: ocrResult.documentTypeLabel,
            customerName: customerMatch.leadName,
            customerEmail: null,
            customerId: customerMatch.leadId,
            emailFrom: null,
            ocrConfidence: ocrResult.overallConfidence,
            filename: file.originalname,
            personenNamen: ocrResult.personenNamen,
          }).catch((err: any) => console.error(`[Documents] Pipedrive failed: ${err.message}`));

          results.push({
            id: doc.id,
            filename: file.originalname,
            documentType: ocrResult.documentType,
            documentTypeLabel: ocrResult.documentTypeLabel,
            fields: ocrResult.fields,
            confidence: ocrResult.overallConfidence,
          });
        } catch (err: any) {
          results.push({ filename: file.originalname, error: err.message });
        }
      }

      res.json({ documents: results });
    } catch (err: any) {
      console.error('[Documents] Error uploading:', err);
      res.status(500).json({ error: err.message });
    }
  }

  // ============================================================
  // GET /api/documents/stats
  // ============================================================
  async getStats(req: Request, res: Response) {
    try {
      const [total, completed, processing, pending, failed, assigned, unassigned] =
        await Promise.all([
          prisma.document.count(),
          prisma.document.count({ where: { ocrStatus: 'COMPLETED' } }),
          prisma.document.count({ where: { ocrStatus: 'PROCESSING' } }),
          prisma.document.count({ where: { ocrStatus: 'PENDING' } }),
          prisma.document.count({ where: { ocrStatus: 'FAILED' } }),
          prisma.document.count({ where: { leadId: { not: null } } }),
          prisma.document.count({ where: { leadId: null, ocrStatus: 'COMPLETED' } }),
        ]);

      const [gehaltszettel, kontoauszug, kaufvertrag, grundbuchauszug, sonstiges] =
        await Promise.all([
          prisma.document.count({ where: { type: 'GEHALTSABRECHNUNG' } }),
          prisma.document.count({ where: { type: 'KONTOAUSZUG' } }),
          prisma.document.count({ where: { type: 'KAUFVERTRAG' } }),
          prisma.document.count({ where: { type: 'GRUNDBUCHAUSZUG' } }),
          prisma.document.count({ where: { type: 'SONSTIGES' } }),
        ]);

      const recentEmails = await prisma.emailLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      res.json({
        documents: {
          total_documents: String(total),
          completed: String(completed),
          processing: String(processing),
          pending: String(pending),
          failed: String(failed),
          assigned: String(assigned),
          unassigned: String(unassigned),
          gehaltszettel: String(gehaltszettel),
          kontoauszug: String(kontoauszug),
          kaufvertrag: String(kaufvertrag),
          grundbuchauszug: String(grundbuchauszug),
          sonstiges: String(sonstiges),
        },
        recent_emails: recentEmails,
      });
    } catch (err: any) {
      console.error('[Documents] Error fetching stats:', err);
      res.status(500).json({ error: err.message });
    }
  }

  // ============================================================
  // POST /api/documents/inbound - SendGrid Webhook
  // ============================================================
  async inboundWebhook(req: Request, res: Response) {
    try {
      console.log('[Webhook] SendGrid Inbound Parse received');

      const from = req.body.from || req.body.sender || '';
      const subject = req.body.subject || '(kein Betreff)';
      const messageId = req.body['Message-ID'] || `sg-${Date.now()}`;

      const emailMatch = from.match(/<(.+?)>/) || [null, from];
      const emailAddress = emailMatch[1] || from;

      const attachments: any[] = [];

      if (req.files && Array.isArray(req.files)) {
        for (const file of req.files as Express.Multer.File[]) {
          attachments.push({
            filename: file.originalname,
            mimeType: file.mimetype,
            content: file.buffer,
            size: file.size,
          });
        }
      }

      res.status(200).json({ received: true });

      processIncomingEmail({
        from: emailAddress,
        subject,
        messageId,
        attachments,
        receivedAt: new Date(),
      }).catch((err) => console.error('[Webhook] Processing error:', err));
    } catch (err: any) {
      console.error('[Webhook] Error:', err);
      res.status(200).json({ error: err.message });
    }
  }

  // ============================================================
  // GET /api/documents/types
  // ============================================================
  async getDocumentTypes(req: Request, res: Response) {
    res.json({ schemas: DOCUMENT_SCHEMAS });
  }

  // ============================================================
  // POST /api/documents/n8n-upload - Upload from n8n IMAP workflow
  // NOW with: auto lead creation + drive folder + drive upload
  // FIX: No double folder creation — autoCreateLead creates folder,
  //       ensureDriveFolder only creates if missing (awaits properly)
  // ============================================================
  async n8nUpload(req: Request, res: Response) {
    try {
      console.log('[n8n-Upload] Received request');

      const { filename, mimeType, fileBase64, emailFrom, emailSubject, fileSize, emailBody, targetFolderId } = req.body;

      if (!fileBase64) {
        return res.status(400).json({ error: 'No fileBase64 provided' });
      }

      // Serialize requests from the same sender to prevent race conditions
      // (e.g. 2 attachments from same email → both would create separate leads/folders)
      const emailKey = emailFrom || 'unknown';
      const result = await withEmailLock(emailKey, () => this._processN8nUpload(req.body));

      return res.json(result);
    } catch (err: any) {
      console.error('[n8n-Upload] Error:', err);
      res.status(500).json({ error: err.message });
    }
  }

  async _processN8nUpload(body: any) {
      const { filename, mimeType, fileBase64, emailFrom, emailSubject, fileSize, emailBody, targetFolderId } = body;

      let fileBuffer = Buffer.from(fileBase64, 'base64');
      let actualFilename = filename || 'dokument.pdf';
      let actualMimeType = mimeType || 'application/octet-stream';

      // Convert HEIC/HEIF to JPEG
      if (actualMimeType === 'image/heic' || actualMimeType === 'image/heif' || actualFilename.toLowerCase().endsWith('.heic') || actualFilename.toLowerCase().endsWith('.heif')) {
        try {
          const heicConvert = require('heic-convert');
          console.log(`[n8n-Upload] Converting HEIC to JPEG: ${actualFilename}`);
          const outputBuffer = await heicConvert({
            buffer: fileBuffer,
            format: 'JPEG',
            quality: 0.9,
          });
          fileBuffer = Buffer.from(outputBuffer);
          actualMimeType = 'image/jpeg';
          actualFilename = actualFilename.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg');
          console.log(`[n8n-Upload] HEIC converted: ${actualFilename} (${fileBuffer.length} bytes)`);
        } catch (err: any) {
          console.error(`[n8n-Upload] HEIC conversion failed: ${err.message}`);
          throw new Error(`HEIC-Konvertierung fehlgeschlagen: ${err.message}`);
        }
      }

      const actualSize = fileBuffer.length;
      console.log(`[n8n-Upload] Processing: ${actualFilename} (${actualMimeType}, ${actualSize} bytes)`);

      // Run OCR
      const ocrResult = await analyzeDocument(fileBuffer, actualMimeType, actualFilename);

      // Only process relevant document types
      const RELEVANT_TYPES = ['REISEPASS', 'GEHALTSABRECHNUNG', 'KONTOAUSZUG', 'AUSWEIS', 'KAUFVERTRAG', 'GRUNDBUCHAUSZUG'];
      const isRelevant = RELEVANT_TYPES.includes(ocrResult.prismaType);

      if (!isRelevant) {
        console.log(`[n8n-Upload] ⏭️ Skipping irrelevant: ${actualFilename} (type: ${ocrResult.documentTypeLabel})`);
        return {
          success: true,
          skipped: true,
          reason: `Dokumenttyp "${ocrResult.documentTypeLabel}" ist nicht relevant`,
          documentType: ocrResult.documentTypeLabel,
        };
      }

      // Match customer
      let customerMatch = await matchCustomer(emailFrom || null, ocrResult.personenNamen, ocrResult.fields);

      // ── AUTO-CREATE LEAD if no match found ──
      // NOTE: autoCreateLead already creates the Google Drive folder internally
      //       so we do NOT call ensureDriveFolder afterwards for new leads
      let isNewlyCreatedLead = false;
      if (!customerMatch.leadId && emailFrom) {
        console.log(`[n8n-Upload] No lead found — auto-creating from ${emailFrom}...`);
        const autoLead = await autoCreateLead(emailFrom, ocrResult.personenNamen, ocrResult.fields, targetFolderId);
        customerMatch = {
          leadId: autoLead.leadId,
          leadName: autoLead.leadName,
          method: 'EMAIL_MATCH' as const,
          confidence: 0.7,
        };
        isNewlyCreatedLead = true;
      }

      // ── Ensure lead has Drive folder (ONLY for existing leads without one) ──
      // Skip if we just created the lead (autoCreateLead already made the folder)
      if (customerMatch.leadId && !isNewlyCreatedLead) {
        await ensureDriveFolder(customerMatch.leadId, targetFolderId);
      }

      // Save document
      const doc = await prisma.document.create({
        data: {
          leadId: customerMatch.leadId || undefined,
          filename: actualFilename,
          originalFilename: actualFilename,
          type: (ocrResult.prismaType as any) || 'SONSTIGES',
          mimeType: actualMimeType,
          size: actualSize,
          emailFrom: emailFrom || null,
          emailSubject: emailSubject || null,
          extractedData: ocrResult.fields as any,
          ocrStatus: 'COMPLETED',
          ocrProcessedAt: new Date(),
          ocrConfidence: ocrResult.overallConfidence,
          assignmentMethod: (customerMatch.method as any) || 'UNASSIGNED',
          assignmentConfidence: customerMatch.confidence,
        },
      });

      // ── Upload to Google Drive (images will be auto-converted to PDF) ──
      if (customerMatch.leadId) {
        uploadToCustomerDrive(
          fileBuffer,
          actualFilename,
          actualMimeType,
          customerMatch.leadId,
          doc.id,
          ocrResult.prismaType,  // e.g. "GEHALTSABRECHNUNG", "REISEPASS"
        ).catch((err) => console.error(`[n8n-Upload] GDrive upload failed: ${err.message}`));
      }

      // Activity log
      if (customerMatch.leadId) {
        await prisma.activity.create({
          data: {
            leadId: customerMatch.leadId,
            type: 'DOCUMENT_UPLOADED',
            title: `Dokument per Email: ${ocrResult.documentTypeLabel}`,
            description: `${actualFilename} von ${emailFrom || 'unbekannt'} (${(customerMatch.confidence * 100).toFixed(0)}% Konfidenz)`,
            data: {
              documentId: doc.id,
              documentType: ocrResult.documentType,
              assignmentMethod: customerMatch.method,
            } as any,
          },
        });
      }

      // Pipedrive
      try {
        await processDocumentInPipedrive({
          documentId: doc.id,
          documentType: ocrResult.documentType,
          documentTypeLabel: ocrResult.documentTypeLabel,
          customerName: customerMatch.leadName,
          customerEmail: null,
          customerId: customerMatch.leadId,
          emailFrom: emailFrom || null,
          ocrConfidence: ocrResult.overallConfidence,
          filename: actualFilename,
          personenNamen: ocrResult.personenNamen,
          emailBody: emailBody || null,
        });
      } catch (err: any) {
        console.error(`[n8n-Upload] Pipedrive failed (non-fatal): ${err.message}`);
      }

      console.log(`[n8n-Upload] ✅ ${actualFilename} → ${ocrResult.documentTypeLabel} (${customerMatch.leadName || 'nicht zugeordnet'})`);

      return {
        success: true,
        document: {
          id: doc.id,
          filename: actualFilename,
          documentType: ocrResult.documentType,
          documentTypeLabel: ocrResult.documentTypeLabel,
          confidence: ocrResult.overallConfidence,
          customerMatch: customerMatch.leadName,
        },
      };
  }
}

export const documentsController = new DocumentsController();