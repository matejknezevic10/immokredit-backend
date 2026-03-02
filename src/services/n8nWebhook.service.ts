// src/services/n8nWebhook.service.ts

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';

export interface N8nDocumentPayload {
  documentId: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  documentType: string;
  documentTypeLabel: string;
  ocrConfidence: number;
  extractedData: Record<string, any>;
  personenNamen: string[];
  customerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  assignmentMethod: string;
  assignmentConfidence: number;
  emailFrom: string | null;
  emailSubject: string | null;
  processedAt: string;
}

/**
 * Sendet verarbeitete Dokument-Daten + Originaldatei (base64) an n8n Webhook
 */
export async function sendToN8n(
  payload: N8nDocumentPayload,
  fileBuffer: Buffer,
): Promise<boolean> {
  if (!N8N_WEBHOOK_URL) {
    console.log('[n8n] No webhook URL configured, skipping');
    return false;
  }

  try {
    console.log(`[n8n] Sending document ${payload.filename} to n8n...`);

    const body = {
      ...payload,
      fileBase64: fileBuffer.toString('base64'),
    };

    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`n8n responded with ${response.status}: ${errorText}`);
    }

    console.log(`[n8n] ✅ Document sent successfully: ${payload.filename}`);
    return true;
  } catch (err: any) {
    console.error(`[n8n] ❌ Failed to send document: ${err.message}`);
    return false;
  }
}

/**
 * Sendet nur Metadaten an n8n (ohne Datei)
 */
export async function sendEventToN8n(
  event: string,
  data: Record<string, any>,
): Promise<boolean> {
  if (!N8N_WEBHOOK_URL) return false;

  try {
    console.log(`[n8n] Sending event: ${event}`);

    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...data, timestamp: new Date().toISOString() }),
    });

    if (!response.ok) {
      throw new Error(`n8n responded with ${response.status}`);
    }

    console.log(`[n8n] ✅ Event sent: ${event}`);
    return true;
  } catch (err: any) {
    console.error(`[n8n] ❌ Failed to send event: ${err.message}`);
    return false;
  }
}
