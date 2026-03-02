// src/services/customerMatching.service.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface MatchResult {
  leadId: string | null;
  leadName: string | null;
  method: 'EMAIL_MATCH' | 'NAME_MATCH' | 'MANUAL' | 'UNASSIGNED';
  confidence: number;
}

/**
 * Normalize diacritics: ž→z, ć→c, č→c, š→s, đ→d, ü→u, ö→o, ä→a, ß→ss etc.
 */
function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .trim();
}

/**
 * Versucht einen Lead anhand von Email, Name etc. zu finden.
 * Priorität: Email > Exakter Name > Normalisierter Name > Teilname
 */
export async function matchCustomer(
  emailFrom: string | null,
  personenNamen: string[] = [],
  extractedFields: Record<string, { value: string | number | null; confidence: number }> = {}
): Promise<MatchResult> {
  console.log(`[Matching] Searching for: email=${emailFrom}, names=${personenNamen.join(', ')}`);

  // 1. Match via Email (highest priority)
  if (emailFrom) {
    const lead = await prisma.lead.findFirst({
      where: { email: { equals: emailFrom.toLowerCase(), mode: 'insensitive' } },
    });

    if (lead) {
      console.log(`[Matching] ✅ Email match: ${lead.firstName} ${lead.lastName}`);
      return {
        leadId: lead.id,
        leadName: `${lead.firstName} ${lead.lastName}`,
        method: 'EMAIL_MATCH',
        confidence: 0.95,
      };
    }
  }

  // 2. Collect all possible names from document
  const allNames = [
    ...personenNamen,
    ...[
      extractedFields.arbeitnehmer_name,
      extractedFields.kontoinhaber,
      extractedFields.kaeufer_name,
      extractedFields.eigentuemer,
      extractedFields.inhaber_name,
      extractedFields.nachname,
      extractedFields.vorname,
    ]
      .map((f) => f?.value as string)
      .filter(Boolean),
  ];

  // Also try combining vorname + nachname if both exist
  if (extractedFields.vorname?.value && extractedFields.nachname?.value) {
    allNames.push(`${extractedFields.vorname.value} ${extractedFields.nachname.value}`);
  }

  // Get all leads once for normalized comparison
  const allLeads = await prisma.lead.findMany({
    select: { id: true, firstName: true, lastName: true, email: true },
  });

  for (const name of allNames) {
    if (!name || name.length < 3) continue;

    const parts = name.trim().split(/\s+/);
    if (parts.length < 2) continue;

    const firstName = parts[0];
    const lastName = parts[parts.length - 1];

    // 2a. Exact match (case-insensitive via Prisma)
    const exactMatch = await prisma.lead.findFirst({
      where: {
        OR: [
          {
            firstName: { equals: firstName, mode: 'insensitive' },
            lastName: { equals: lastName, mode: 'insensitive' },
          },
          {
            firstName: { equals: lastName, mode: 'insensitive' },
            lastName: { equals: firstName, mode: 'insensitive' },
          },
        ],
      },
    });

    if (exactMatch) {
      console.log(`[Matching] ✅ Exact name match: ${exactMatch.firstName} ${exactMatch.lastName}`);
      return {
        leadId: exactMatch.id,
        leadName: `${exactMatch.firstName} ${exactMatch.lastName}`,
        method: 'NAME_MATCH',
        confidence: 0.9,
      };
    }

    // 2b. Normalized match (handles KNEŽEVIĆ → Knezevic, Müller → Mueller etc.)
    const normFirst = normalizeText(firstName);
    const normLast = normalizeText(lastName);

    const normalizedMatch = allLeads.find((lead) => {
      const leadFirst = normalizeText(lead.firstName);
      const leadLast = normalizeText(lead.lastName);
      return (
        (leadFirst === normFirst && leadLast === normLast) ||
        (leadFirst === normLast && leadLast === normFirst)
      );
    });

    if (normalizedMatch) {
      console.log(`[Matching] ✅ Normalized match: ${normalizedMatch.firstName} ${normalizedMatch.lastName} (from "${firstName} ${lastName}")`);
      return {
        leadId: normalizedMatch.id,
        leadName: `${normalizedMatch.firstName} ${normalizedMatch.lastName}`,
        method: 'NAME_MATCH',
        confidence: 0.85,
      };
    }

    // 2c. Partial last name match (normalized)
    const partialMatch = allLeads.find((lead) => {
      const leadLast = normalizeText(lead.lastName);
      return leadLast.includes(normLast) || normLast.includes(leadLast);
    });

    if (partialMatch) {
      console.log(`[Matching] ✅ Partial match: ${partialMatch.firstName} ${partialMatch.lastName}`);
      return {
        leadId: partialMatch.id,
        leadName: `${partialMatch.firstName} ${partialMatch.lastName}`,
        method: 'NAME_MATCH',
        confidence: 0.6,
      };
    }
  }

  console.log('[Matching] ❌ No match found');
  return {
    leadId: null,
    leadName: null,
    method: 'UNASSIGNED',
    confidence: 0,
  };
}