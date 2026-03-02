// src/services/voicememo.service.ts

interface ExtractedLeadData {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  amount: number | null;
  message: string | null;
}

/**
 * Process voice memo: transcribe with Whisper, extract fields with regex
 */
export async function processVoiceMemo(audioBuffer: Buffer, mimeType: string): Promise<{
  transcript: string;
  extracted: ExtractedLeadData;
}> {
  const transcript = await transcribeWithWhisper(audioBuffer, mimeType);
  console.log('[VoiceMemo] Transcript:', transcript);

  const extracted = extractLeadDataFromText(transcript);
  console.log('[VoiceMemo] Extracted:', extracted);

  return { transcript, extracted };
}

/**
 * Transcribe audio using OpenAI Whisper API
 */
async function transcribeWithWhisper(audioBuffer: Buffer, mimeType: string): Promise<string> {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY ist nicht konfiguriert');

  const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'mp4' : 'wav';

  const formData = new FormData();
  const fileBlob = new Blob([audioBuffer], { type: mimeType });
  formData.append('file', fileBlob, `voicememo.${ext}`);
  formData.append('model', 'whisper-1');
  formData.append('language', 'de');
  formData.append('prompt', 'Finanzierung, Kredit, Immobilie, ImmoKredit, Eigenmittel, Euro, E-Mail, at, punkt');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[VoiceMemo] Whisper error:', errText);
    throw new Error(`Whisper API error: ${res.status}`);
  }

  const data: any = await res.json();
  return data.text || '';
}

/**
 * Extract lead fields from German transcript using regex
 * No external API needed
 */
function extractLeadDataFromText(text: string): ExtractedLeadData {
  const result: ExtractedLeadData = {
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
    source: null,
    amount: null,
    message: text, // Always store full transcript
  };

  const lower = text.toLowerCase();

  // ── Name ──
  // Use \p{Lu} (uppercase) and \p{Ll} (lowercase) for full Unicode: Knežević, Müller, Özdemir
  // Case-insensitive flag (i) + unicode flag (u) to match "Kunde" / "kunde"
  const namePatterns = [
    /(?:kunde|kundin|herr|frau|name(?:\s+ist)?)\s+([\p{Lu}][\p{Ll}]+)\s+([\p{Lu}][\p{Ll}]+)/iu,
    /(?:neuer?\s+lead)\s+([\p{Lu}][\p{Ll}]+)\s+([\p{Lu}][\p{Ll}]+)/iu,
    /(?:für|von)\s+([\p{Lu}][\p{Ll}]+)\s+([\p{Lu}][\p{Ll}]+)/iu,
  ];
  for (const p of namePatterns) {
    const m = text.match(p);
    if (m) { result.firstName = m[1]; result.lastName = m[2]; break; }
  }

  // ── Email ──
  // Step 1: Find the email region in the text (after "E-Mail" keyword)
  // Step 2: Only apply at→@ replacement in that region to avoid corrupting words like "matej"
  let emailText = text;

  // First try: find email region after "E-Mail" keyword
  const emailRegionMatch = text.match(/(?:e-?mail(?:\s+adresse)?)[:\s]+(.{5,60}?)(?:\s+und\s|\s+der\s|\s+mit\s|\.\s|$)/i);
  if (emailRegionMatch) {
    let emailPart = emailRegionMatch[1].trim();
    // Apply spoken replacements only to this isolated region
    emailPart = emailPart
      .replace(/\s+(?:underscore|unterstrich)\s+/gi, '_')
      .replace(/\s+(?:bindestrich|minus|strich|dash)\s+/gi, '-')
      .replace(/\s+at\s+/gi, '@')
      .replace(/\s+ät\s+/gi, '@')
      .replace(/\s+punkt\s+/gi, '.')
      .replace(/\s+dot\s+/gi, '.')
      .replace(/\s+/g, ''); // remove remaining spaces in email

    const match = emailPart.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})/i);
    if (match) result.email = match[1].toLowerCase();
  }

  // Fallback: look for standard email pattern anywhere in the text
  if (!result.email) {
    // Apply global replacements but ONLY " at " with spaces (not "at" inside words)
    emailText = text
      .replace(/\s+(?:underscore|unterstrich)\s+/gi, '_')
      .replace(/\s+(?:bindestrich|minus|strich|dash)\s+/gi, '-')
      .replace(/\s+at\s+/gi, '@')
      .replace(/\s+ät\s+/gi, '@')
      .replace(/\s+punkt\s+/gi, '.')
      .replace(/\s+dot\s+/gi, '.');

    const match = emailText.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})/i);
    if (match) result.email = match[1].toLowerCase();
  }

  // ── Phone ──
  const phonePatterns = [
    /(?:telefon(?:nummer)?|nummer|handy|mobil|tel)[:\s]*(\+?\s*[\d\s/-]{8,})/i,
    /(0\d{3,4}[\s/-]?\d{3,}[\s/-]?\d{2,})/,
    /(\+43[\s/-]?\d{3,}[\s/-]?\d{3,}[\s/-]?\d{2,})/,
  ];
  for (const p of phonePatterns) {
    const m = text.match(p);
    if (m) {
      let phone = m[1].replace(/\s+/g, ' ').trim();
      if (phone.startsWith('0')) phone = '+43 ' + phone.substring(1);
      result.phone = phone;
      break;
    }
  }

  // ── Amount ──
  // Handle "200.000 Euro", "250000 Euro", "200 tausend Euro"
  const amountPatterns = [
    /(\d{1,3}(?:\.\d{3})+)\s*(?:euro|€)/i,                    // 200.000 Euro
    /(\d+)\s*(?:tausend)\s*(?:euro|€)/i,                       // 200 tausend Euro
    /(?:finanzierung(?:ssumme)?|kredit(?:summe)?|betrag|summe)[:\s]*(?:von\s+)?(\d[\d.]*)\s*(?:euro|€)?/i,
    /(?:braucht|möchte|will|benötigt)\s+(?:einen?\s+)?(?:kredit|finanzierung)\s+(?:von\s+|über\s+)?(\d[\d.]*)\s*(?:euro|€)?/i,
    /(\d[\d.]*)\s*(?:euro|€)/i,                                // fallback: any number + Euro
  ];
  for (const p of amountPatterns) {
    const m = text.match(p);
    if (m) {
      const rawNum = m[2] || m[1];
      const numStr = rawNum.replace(/\./g, '');
      let amount = parseInt(numStr, 10);
      // "200 tausend" → 200000
      if (lower.includes('tausend') && amount < 10000) amount *= 1000;
      if (amount >= 1000) { result.amount = amount; break; }
    }
  }

  // ── Source ──
  const sourceMap: [string, string][] = [
    ['empfehlung', 'Empfehlung'], ['empfohlen', 'Empfehlung'], ['weiterempfehlung', 'Empfehlung'],
    ['bekannter', 'Empfehlung'], ['freund', 'Empfehlung'], ['kollege', 'Empfehlung'],
    ['facebook', 'Facebook'], ['instagram', 'Facebook'],
    ['google', 'Google Ads'],
    ['website', 'Website'], ['webseite', 'Website'], ['homepage', 'Website'], ['online', 'Website'],
    ['telefonat', 'Telefonat'], ['angerufen', 'Telefonat'], ['anruf', 'Telefonat'],
    ['vor ort', 'Vor Ort'], ['büro', 'Vor Ort'], ['persönlich', 'Vor Ort'], ['termin', 'Vor Ort'],
  ];
  for (const [keyword, source] of sourceMap) {
    if (lower.includes(keyword)) { result.source = source; break; }
  }

  return result;
}