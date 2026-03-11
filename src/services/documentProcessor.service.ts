// src/services/documentProcessor.service.ts
import { PrismaClient, DocumentType, OcrStatus, AssignmentMethod, AmpelStatus, Temperatur } from '@prisma/client';
import { analyzeDocument, DOCUMENT_SCHEMAS } from './ocr.service';
import { matchCustomer } from './customerMatching.service';
import { processDocumentInPipedrive } from './pipedrive.service';
import { createCustomerFolder, uploadFileToCustomerFolder } from './googleDrive.service';

const prisma = new PrismaClient();

// ============================================================
// Types
// ============================================================

interface EmailAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
  size: number;
}

interface EmailData {
  from: string;
  subject: string;
  messageId: string;
  attachments: EmailAttachment[];
  receivedAt: Date;
}

interface ProcessingResult {
  logId: string;
  documentsCreated: number;
  documents: any[];
}

const TYPE_MAP: Record<string, DocumentType> = {
  GEHALTSABRECHNUNG: 'GEHALTSABRECHNUNG',
  KONTOAUSZUG: 'KONTOAUSZUG',
  KAUFVERTRAG: 'KAUFVERTRAG',
  GRUNDBUCHAUSZUG: 'GRUNDBUCHAUSZUG',
  SONSTIGES: 'SONSTIGES',
};

const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

// ============================================================
// Helper: Auto-create Lead from OCR data + Email
// ============================================================

async function autoCreateLead(
  emailFrom: string,
  personenNamen: string[],
  extractedFields: Record<string, { value: string | number | null; confidence: number }>,
): Promise<{ leadId: string; leadName: string; googleDriveFolderId: string | null }> {

  let firstName = '';
  let lastName = '';

  // Priority 1: vorname + nachname fields from OCR
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

  // Priority 3: Other name fields from OCR
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

  // Priority 4: Use email prefix as fallback
  if (!firstName) {
    const emailPrefix = emailFrom.split('@')[0];
    const parts = emailPrefix.replace(/[._-]/g, ' ').split(/\s+/);
    firstName = parts[0] || 'Unbekannt';
    lastName = parts.slice(1).join(' ') || 'Unbekannt';
  }

  // Capitalize
  firstName = firstName.charAt(0).toUpperCase() + firstName.slice(1);
  if (lastName) lastName = lastName.charAt(0).toUpperCase() + lastName.slice(1);

  console.log(`[AutoLead] Creating lead: ${firstName} ${lastName} (${emailFrom})`);

  // Create Lead
  const lead = await prisma.lead.create({
    data: {
      firstName,
      lastName: lastName || 'Unbekannt',
      email: emailFrom,
      phone: '',
      source: 'EMAIL',
      ampelStatus: AmpelStatus.YELLOW,
      temperatur: Temperatur.WARM,
      score: 0,
    },
  });

  // Activity log
  await prisma.activity.create({
    data: {
      leadId: lead.id,
      type: 'LEAD_CREATED',
      title: 'Lead automatisch erstellt',
      description: `Lead wurde automatisch aus Email von ${emailFrom} erstellt`,
    },
  });

  // Create Google Drive folder
  let googleDriveFolderId: string | null = null;
  try {
    const { folderId, folderUrl } = await createCustomerFolder(firstName, lastName || 'Unbekannt');
    googleDriveFolderId = folderId;

    await prisma.lead.update({
      where: { id: lead.id },
      data: { googleDriveFolderId: folderId, googleDriveFolderUrl: folderUrl },
    });

    console.log(`[AutoLead] ✅ Lead + Drive folder: ${firstName} ${lastName} → ${folderUrl}`);
  } catch (err: any) {
    console.error(`[AutoLead] ⚠️ Google Drive folder failed: ${err.message}`);
  }

  return { leadId: lead.id, leadName: `${firstName} ${lastName}`, googleDriveFolderId };
}

// ============================================================
// Helper: Upload to Google Drive
// ============================================================

async function uploadToGDrive(
  fileBuffer: Buffer,
  filename: string,
  mimeType: string,
  leadId: string | null,
  documentId: string,
) {
  if (!leadId) return;

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead?.googleDriveFolderId) {
    console.error(`[GDrive] Lead ${leadId} has no folder — skipping upload for ${filename}`);
    return;
  }

  const result = await uploadFileToCustomerFolder(
    fileBuffer,
    filename,
    mimeType,
    lead.googleDriveFolderId,
  );

  await prisma.document.update({
    where: { id: documentId },
    data: {
      googleDriveId: result.fileId,
      googleDriveUrl: result.webViewLink,
    },
  });

  console.log(`[GDrive] ✅ ${filename} → ${lead.firstName} ${lead.lastName} folder`);
}

// ============================================================
// Process Incoming Email
// ============================================================

export async function processIncomingEmail(emailData: EmailData): Promise<ProcessingResult> {
  const { from, subject, messageId, attachments, receivedAt } = emailData;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Processor] New email from: ${from}`);
  console.log(`[Processor] Subject: ${subject}`);
  console.log(`[Processor] Attachments: ${attachments.length}`);
  console.log('='.repeat(60));

  const emailLog = await prisma.emailLog.create({
    data: {
      emailMessageId: messageId,
      emailFrom: from,
      emailSubject: subject,
      attachmentsCount: attachments.length,
      status: 'processing',
    },
  });

  if (attachments.length === 0) {
    await prisma.emailLog.update({
      where: { id: emailLog.id },
      data: { status: 'completed', completedAt: new Date() },
    });
    console.log('[Processor] No attachments to process');
    return { logId: emailLog.id, documentsCreated: 0, documents: [] };
  }

  let documentsCreated = 0;
  const processedDocuments: any[] = [];

  // Track lead across all attachments from same email
  let resolvedLeadId: string | null = null;

  for (const attachment of attachments) {
    try {
      const doc = await processSingleAttachment(
        attachment,
        { from, subject, messageId, receivedAt },
        resolvedLeadId,
      );
      if (doc) {
        processedDocuments.push(doc);
        documentsCreated++;
        // Remember lead for subsequent attachments from same email
        if (doc.leadId && !resolvedLeadId) {
          resolvedLeadId = doc.leadId;
        }
      }
    } catch (err: any) {
      console.error(`[Processor] Error processing ${attachment.filename}:`, err.message);

      await prisma.document.create({
        data: {
          filename: attachment.filename,
          originalFilename: attachment.filename,
          type: 'SONSTIGES',
          mimeType: attachment.mimeType,
          size: attachment.size,
          emailFrom: from,
          emailSubject: subject,
          emailMessageId: messageId,
          emailReceivedAt: receivedAt,
          ocrStatus: 'FAILED',
          ocrError: err.message,
          assignmentMethod: 'UNASSIGNED',
        },
      });
    }
  }

  await prisma.emailLog.update({
    where: { id: emailLog.id },
    data: { status: 'completed', documentsCreated, completedAt: new Date() },
  });

  console.log(`[Processor] ✅ Email processed: ${documentsCreated}/${attachments.length} documents`);
  return { logId: emailLog.id, documentsCreated, documents: processedDocuments };
}

// ============================================================
// Process Single Attachment
// ============================================================

async function processSingleAttachment(
  attachment: EmailAttachment,
  emailMeta: { from: string; subject: string; messageId: string; receivedAt: Date },
  existingLeadId: string | null = null,
) {
  const { filename, mimeType, content, size } = attachment;
  const { from, subject, messageId, receivedAt } = emailMeta;

  console.log(`\n[Processor] Processing: ${filename} (${mimeType}, ${(size / 1024).toFixed(1)} KB)`);

  if (!SUPPORTED_MIME_TYPES.includes(mimeType)) {
    console.log(`[Processor] Skipping unsupported type: ${mimeType}`);
    return null;
  }

  const document = await prisma.document.create({
    data: {
      filename,
      originalFilename: filename,
      type: 'SONSTIGES',
      mimeType,
      size,
      emailFrom: from,
      emailSubject: subject,
      emailMessageId: messageId,
      emailReceivedAt: receivedAt,
      ocrStatus: 'PROCESSING',
      assignmentMethod: 'UNASSIGNED',
    },
  });

  try {
    // Run OCR
    const ocrResult = await analyzeDocument(
      Buffer.isBuffer(content) ? content : Buffer.from(content, 'base64'),
      mimeType,
      filename
    );

    const RELEVANT_TYPES = ['REISEPASS', 'GEHALTSABRECHNUNG', 'KONTOAUSZUG', 'AUSWEIS', 'KAUFVERTRAG', 'GRUNDBUCHAUSZUG'];
    const isRelevant = RELEVANT_TYPES.includes(ocrResult.prismaType);

    if (!isRelevant) {
      console.log(`[Processor] ⏭️ Skipping irrelevant: ${filename} (type: ${ocrResult.documentTypeLabel})`);
      await prisma.document.delete({ where: { id: document.id } });
      return null;
    }

    // Match customer — reuse lead from previous attachment if available
    let customerMatch;
    if (existingLeadId) {
      const lead = await prisma.lead.findUnique({ where: { id: existingLeadId } });
      customerMatch = {
        leadId: existingLeadId,
        leadName: lead ? `${lead.firstName} ${lead.lastName}` : null,
        method: 'EMAIL_MATCH' as const,
        confidence: 0.95,
      };
    } else {
      customerMatch = await matchCustomer(from, ocrResult.personenNamen, ocrResult.fields);
    }

    // ── AUTO-CREATE LEAD if no match found ──
    if (!customerMatch.leadId) {
      console.log(`[Processor] No lead found — auto-creating...`);
      const autoLead = await autoCreateLead(from, ocrResult.personenNamen, ocrResult.fields);
      customerMatch = {
        leadId: autoLead.leadId,
        leadName: autoLead.leadName,
        method: 'EMAIL_MATCH' as const,
        confidence: 0.7,
      };
    }

    // Ensure lead has a Google Drive folder (for existing leads without one)
    const lead = await prisma.lead.findUnique({ where: { id: customerMatch.leadId! } });
    if (lead && !lead.googleDriveFolderId) {
      try {
        const { folderId, folderUrl } = await createCustomerFolder(lead.firstName, lead.lastName);
        await prisma.lead.update({
          where: { id: lead.id },
          data: { googleDriveFolderId: folderId, googleDriveFolderUrl: folderUrl },
        });
        console.log(`[Processor] Created missing Drive folder for ${lead.firstName} ${lead.lastName}`);
      } catch (err: any) {
        console.error(`[Processor] ⚠️ Drive folder creation failed: ${err.message}`);
        // Continue without Drive upload — document is still saved in DB
      }
    }

    // Update document
    const updatedDoc = await prisma.document.update({
      where: { id: document.id },
      data: {
        leadId: customerMatch.leadId,
        type: (TYPE_MAP[ocrResult.prismaType] || 'SONSTIGES') as DocumentType,
        extractedData: ocrResult.fields as any,
        ocrStatus: 'COMPLETED',
        ocrProcessedAt: new Date(),
        ocrConfidence: ocrResult.overallConfidence,
        assignmentMethod: customerMatch.method as AssignmentMethod,
        assignmentConfidence: customerMatch.confidence,
      },
      include: { lead: true },
    });

    // ── Upload to Google Drive ──
    const fileBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'base64');
    try {
      await uploadToGDrive(
        fileBuffer,
        filename,
        mimeType,
        customerMatch.leadId,
        document.id,
      );
    } catch (err: any) {
      console.error(`[Processor] GDrive upload failed: ${err.message}`);
    }

    // Pipedrive
    processDocumentInPipedrive({
      documentId: document.id,
      documentType: ocrResult.documentType,
      documentTypeLabel: ocrResult.documentTypeLabel,
      customerName: customerMatch.leadName,
      customerEmail: updatedDoc.lead?.email || null,
      customerId: customerMatch.leadId,
      emailFrom: from,
      ocrConfidence: ocrResult.overallConfidence,
      filename,
      personenNamen: ocrResult.personenNamen,
    }).catch((err: any) => {
      console.error(`[Processor] Pipedrive failed (non-fatal): ${err.message}`);
    });

    // Activity log
    if (customerMatch.leadId) {
      await prisma.activity.create({
        data: {
          leadId: customerMatch.leadId,
          type: 'DOCUMENT_UPLOADED',
          title: `Dokument per Email erhalten: ${ocrResult.documentTypeLabel}`,
          description: `${filename} von ${from} automatisch zugeordnet (${(customerMatch.confidence * 100).toFixed(0)}% Konfidenz)`,
          data: {
            documentId: document.id,
            documentType: ocrResult.documentType,
            assignmentMethod: customerMatch.method,
          } as any,
        },
      });
    }

    console.log(`[Processor] ✅ ${document.id}: ${ocrResult.documentTypeLabel} → ${customerMatch.leadName}`);
    return updatedDoc;
  } catch (err: any) {
    await prisma.document.update({
      where: { id: document.id },
      data: { ocrStatus: 'FAILED', ocrError: err.message },
    });
    throw err;
  }
}