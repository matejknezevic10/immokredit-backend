// src/services/signature.service.ts
//
// Digitale Unterschrift Service
// Speichert Unterschriften als PNG, generiert signierte PDF-Deckblätter.
//
// Workflow:
//   1. Deal erreicht Status UNTERLAGEN_VOLLSTAENDIG
//   2. Frontend zeigt Signatur-Pad
//   3. Unterschrift wird als Base64-PNG gespeichert
//   4. Signiertes PDF-Deckblatt wird generiert
//   5. Upload zu Google Drive
//

import { PrismaClient } from '@prisma/client';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const prisma = new PrismaClient() as any;

// ============================================================
// Unterschrift speichern
// ============================================================
export interface SaveSignatureParams {
  leadId: string;
  signatureBase64: string; // PNG als Base64 (data:image/png;base64,...)
  signerName: string;
  signerRole?: string; // 'kunde', 'berater'
}

export interface SaveSignatureResult {
  success: boolean;
  signatureId?: string;
  pdfBuffer?: Buffer;
  error?: string;
}

export async function saveSignature(params: SaveSignatureParams): Promise<SaveSignatureResult> {
  const { leadId, signatureBase64, signerName, signerRole = 'kunde' } = params;

  try {
    // 1. Get lead data
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        personen: true,
        deal: true,
        finanzplan: true,
      },
    });

    if (!lead) return { success: false, error: 'Lead nicht gefunden' };

    // 2. Extract raw base64 (remove data URL prefix)
    const base64Data = signatureBase64.replace(/^data:image\/\w+;base64,/, '');
    const signatureBuffer = Buffer.from(base64Data, 'base64');

    // 3. Generate signed cover PDF
    const pdfBuffer = await generateSignedCoverPdf(lead, signatureBuffer, signerName);

    // 4. Store signature as document
    const doc = await prisma.document.create({
      data: {
        leadId,
        filename: `unterschrift_${signerRole}_${Date.now()}.pdf`,
        originalFilename: `Unterschrift ${signerName}.pdf`,
        type: 'SONSTIGES',
        mimeType: 'application/pdf',
        size: pdfBuffer.length,
        ocrStatus: 'COMPLETED',
        extractedData: {
          signatureType: 'digital',
          signerName,
          signerRole,
          signedAt: new Date().toISOString(),
        },
      },
    });

    // 5. Upload to Google Drive if folder exists
    if (lead.googleDriveFolderId) {
      try {
        const { uploadFileToCustomerFolder } = await import('./googleDrive.service');
        await uploadFileToCustomerFolder(
          pdfBuffer,
          `Unterschrift_${signerName.replace(/\s+/g, '_')}.pdf`,
          'application/pdf',
          lead.googleDriveFolderId,
          'UNTERSCHRIFT',
          `${lead.firstName} ${lead.lastName}`,
        );
      } catch (err) {
        console.warn('[Signature] Google Drive upload failed:', err);
      }
    }

    // 6. Log activity
    await prisma.activity.create({
      data: {
        leadId,
        type: 'WORKFLOW_TRIGGERED',
        title: `Digitale Unterschrift: ${signerName}`,
        description: `${signerRole === 'kunde' ? 'Kunde' : 'Berater'} hat digital unterschrieben`,
        data: { documentId: doc.id, signerName, signerRole },
      },
    });

    console.log(`[Signature] Saved for lead ${leadId} by ${signerName}`);
    return { success: true, signatureId: doc.id, pdfBuffer };
  } catch (err: any) {
    console.error('[Signature] Error:', err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// Signiertes PDF-Deckblatt generieren
// ============================================================
async function generateSignedCoverPdf(
  lead: any,
  signatureBuffer: Buffer,
  signerName: string,
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page = pdfDoc.addPage([595.28, 841.89]); // A4

  const now = new Date();
  const dateStr = now.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  let y = 780;
  const margin = 60;

  // Header
  page.drawText('ImmoKredit', { x: margin, y, font: fontBold, size: 24, color: rgb(0.1, 0.2, 0.4) });
  y -= 25;
  page.drawText('Finanzierungsvermittlung', { x: margin, y, font, size: 11, color: rgb(0.4, 0.4, 0.4) });
  y -= 40;

  // Separator line
  page.drawLine({ start: { x: margin, y }, end: { x: 535, y }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
  y -= 30;

  // Title
  page.drawText('Bestätigung der Finanzierungsunterlagen', { x: margin, y, font: fontBold, size: 16, color: rgb(0.1, 0.1, 0.1) });
  y -= 35;

  // Lead info
  const drawRow = (label: string, value: string) => {
    page.drawText(label, { x: margin, y, font, size: 10, color: rgb(0.4, 0.4, 0.4) });
    page.drawText(value, { x: 200, y, font, size: 10, color: rgb(0.1, 0.1, 0.1) });
    y -= 20;
  };

  drawRow('Kunde:', `${lead.firstName} ${lead.lastName}`);
  drawRow('E-Mail:', lead.email);
  drawRow('Telefon:', lead.phone);
  if (lead.deal?.title) drawRow('Finanzierung:', lead.deal.title);
  if (lead.deal?.value) drawRow('Betrag:', `€ ${lead.deal.value.toLocaleString('de-AT')}`);
  drawRow('Datum:', dateStr);
  y -= 15;

  // Confirmation text
  page.drawLine({ start: { x: margin, y }, end: { x: 535, y }, thickness: 0.5, color: rgb(0.9, 0.9, 0.9) });
  y -= 25;

  const confirmText = [
    'Hiermit bestätige ich, dass alle eingereichten Unterlagen vollständig und',
    'wahrheitsgemäß sind. Ich bin damit einverstanden, dass ImmoKredit die',
    'Unterlagen an Banken und Finanzierungspartner weiterleiten darf, um ein',
    'individuelles Finanzierungsangebot für mich einzuholen.',
  ];

  for (const line of confirmText) {
    page.drawText(line, { x: margin, y, font, size: 11, color: rgb(0.2, 0.2, 0.2) });
    y -= 18;
  }

  y -= 30;

  // Signature area
  page.drawText('Unterschrift:', { x: margin, y, font: fontBold, size: 11, color: rgb(0.1, 0.1, 0.1) });
  y -= 10;

  // Embed signature image
  try {
    const signatureImage = await pdfDoc.embedPng(signatureBuffer);
    const sigDims = signatureImage.scale(0.5);
    const maxWidth = 250;
    const maxHeight = 80;
    const scale = Math.min(maxWidth / sigDims.width, maxHeight / sigDims.height, 1);

    page.drawImage(signatureImage, {
      x: margin,
      y: y - (sigDims.height * scale),
      width: sigDims.width * scale,
      height: sigDims.height * scale,
    });
    y -= (sigDims.height * scale) + 10;
  } catch {
    // If PNG embedding fails, just show placeholder
    page.drawText('[Digitale Unterschrift]', { x: margin, y: y - 30, font, size: 12, color: rgb(0.4, 0.4, 0.4) });
    y -= 50;
  }

  // Signature line
  page.drawLine({ start: { x: margin, y }, end: { x: 300, y }, thickness: 1, color: rgb(0.3, 0.3, 0.3) });
  y -= 15;
  page.drawText(signerName, { x: margin, y, font, size: 10, color: rgb(0.3, 0.3, 0.3) });
  y -= 14;
  page.drawText(dateStr, { x: margin, y, font, size: 9, color: rgb(0.5, 0.5, 0.5) });

  // Footer
  page.drawText('Dieses Dokument wurde digital signiert.', { x: margin, y: 50, font, size: 8, color: rgb(0.6, 0.6, 0.6) });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// ============================================================
// Check ob Lead signiert hat
// ============================================================
export async function getSignatureStatus(leadId: string) {
  const signatures = await prisma.document.findMany({
    where: {
      leadId,
      type: 'SONSTIGES',
      extractedData: {
        path: ['signatureType'],
        equals: 'digital',
      },
    },
    select: {
      id: true,
      originalFilename: true,
      extractedData: true,
      uploadedAt: true,
    },
    orderBy: { uploadedAt: 'desc' },
  });

  return {
    signed: signatures.length > 0,
    signatures: signatures.map(s => ({
      id: s.id,
      filename: s.originalFilename,
      signerName: (s.extractedData as any)?.signerName || 'Unbekannt',
      signerRole: (s.extractedData as any)?.signerRole || 'kunde',
      signedAt: (s.extractedData as any)?.signedAt || s.uploadedAt,
    })),
  };
}
