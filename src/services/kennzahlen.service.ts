// src/services/kennzahlen.service.ts
//
// Berechnet Finanzkennzahlen: DSTI, LTV, geschätzter Immobilienwert
//

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ============================================================
// Austrian average m² prices by PLZ prefix (rough estimates)
// Source: Based on typical Austrian real estate market data
// ============================================================
const PRICE_PER_SQM_BY_REGION: Record<string, number> = {
  // Wien
  '10': 5500, '11': 4200, '12': 4000, '13': 5800, '14': 4500,
  '15': 3800, '16': 4200, '17': 4800, '18': 5200, '19': 6500,
  '10_default': 4800,
  // Niederösterreich
  '20': 2800, '21': 2500, '22': 2300, '23': 2600, '24': 2200,
  '25': 2400, '26': 2200, '27': 2100, '28': 2000, '29': 2300,
  '30': 3200, '31': 2600, '32': 2200, '33': 2100, '34': 2800,
  // Burgenland
  '70': 1800, '71': 1600, '72': 1500, '73': 1400, '74': 1500,
  // Steiermark
  '80': 3500, '81': 2800, '82': 2200, '83': 2000, '84': 1800,
  '85': 2400, '86': 2100, '87': 2000, '88': 2200, '89': 1900,
  // Kärnten
  '90': 2800, '91': 2200, '92': 2000, '93': 1800, '94': 2000,
  '95': 1800, '96': 1700, '97': 1900, '98': 2100,
  // Oberösterreich
  '40': 3200, '41': 2600, '42': 2400, '43': 2200, '44': 2000,
  '45': 2300, '46': 2100, '47': 2000, '48': 2200, '49': 2100,
  // Salzburg
  '50': 5000, '51': 3500, '52': 3000, '53': 2800, '54': 2600,
  '55': 2400, '56': 3200, '57': 2800,
  // Tirol
  '60': 5500, '61': 3800, '62': 3500, '63': 3200, '64': 3000,
  '65': 3400, '66': 3800, '67': 3200,
  // Vorarlberg
  '68': 4500, '69': 4200,
  // Default
  'default': 2800,
};

// Objekttyp-Multiplikatoren
const OBJEKT_TYPE_MULTIPLIERS: Record<string, number> = {
  'Einfamilienhaus': 1.15,
  'Doppelhaushälfte': 1.05,
  'Reihenhaus': 0.95,
  'Eigentumswohnung': 1.0,
  'Wohnung': 1.0,
  'Grundstück': 0.6,  // Nur Grundwert
  'Mehrfamilienhaus': 1.25,
  'Bungalow': 1.1,
  'Villa': 1.4,
};

// Baujahr-Abschlag/Zuschlag
function getBaujahrFactor(baujahr: number | null): number {
  if (!baujahr) return 1.0;
  const age = new Date().getFullYear() - baujahr;
  if (age <= 0) return 1.15;       // Neubau
  if (age <= 5) return 1.10;
  if (age <= 10) return 1.05;
  if (age <= 20) return 1.0;
  if (age <= 30) return 0.95;
  if (age <= 50) return 0.85;
  if (age <= 70) return 0.75;
  return 0.65;                      // Sehr alt
}

// Energiekennzahl-Faktor
function getEnergieFactor(ekz: number | null): number {
  if (!ekz) return 1.0;
  if (ekz <= 25) return 1.08;      // A++
  if (ekz <= 50) return 1.05;      // A+
  if (ekz <= 75) return 1.02;      // A
  if (ekz <= 100) return 1.0;      // B
  if (ekz <= 150) return 0.97;     // C
  if (ekz <= 200) return 0.94;     // D
  if (ekz <= 250) return 0.90;     // E
  return 0.85;                      // F+
}

// ============================================================
// Main: Calculate all financial indicators for a lead
// ============================================================
export interface Kennzahlen {
  // DSTI
  dsti: number | null;                // Debt-Service-To-Income ratio (0-1)
  dstiProzent: number | null;         // DSTI as percentage
  dstiBewertung: 'gut' | 'akzeptabel' | 'kritisch' | 'unvollständig';
  dstiDetails: {
    monatlicheKreditrate: number | null;
    monatlichesNettoeinkommen: number | null;
    bestandskrediteRate: number | null;
    gesamtBelastung: number | null;
  };

  // LTV
  ltv: number | null;                 // Loan-To-Value ratio (0-1+)
  ltvProzent: number | null;          // LTV as percentage
  ltvBewertung: 'gut' | 'akzeptabel' | 'kritisch' | 'unvollständig';
  ltvDetails: {
    finanzierungsbedarf: number | null;
    immobilienwert: number | null;
    eigenmittelQuote: number | null;
  };

  // Geschätzter Immobilienwert
  geschaetzterImmowert: number | null;
  immowertDetails: {
    basisPreisProQm: number | null;
    flaeche: number | null;
    plz: string | null;
    objektTyp: string | null;
    baujahr: number | null;
    objektTypFaktor: number;
    baujahrFaktor: number;
    energieFaktor: number;
    berechnungsMethode: 'kaufpreis' | 'schaetzung' | 'nicht_moeglich';
  };
}

export async function berechneKennzahlen(leadId: string): Promise<Kennzahlen> {
  // Fetch all customer data
  const [haushalt, finanzplan, objekt] = await Promise.all([
    prisma.customerHaushalt.findUnique({ where: { leadId } }),
    prisma.customerFinanzplan.findUnique({ where: { leadId } }),
    prisma.customerObjekt.findFirst({ where: { leadId } }),
  ]);

  // ── Calculate estimated property value ──
  const immowertResult = berechneImmowert(finanzplan, objekt);

  // ── Calculate DSTI ──
  const dstiResult = berechneDSTI(haushalt, finanzplan);

  // ── Calculate LTV ──
  const ltvResult = berechneLTV(finanzplan, immowertResult.geschaetzterImmowert);

  return {
    ...dstiResult,
    ...ltvResult,
    ...immowertResult,
  };
}

// ============================================================
// DSTI Calculation
// ============================================================
function berechneDSTI(haushalt: any, finanzplan: any): Pick<Kennzahlen, 'dsti' | 'dstiProzent' | 'dstiBewertung' | 'dstiDetails'> {
  // Monatliches Nettoeinkommen
  let monatlichesNettoeinkommen: number | null = null;

  if (haushalt?.summeEinnahmen) {
    monatlichesNettoeinkommen = haushalt.summeEinnahmen;
  } else if (haushalt?.einkommen && Array.isArray(haushalt.einkommen)) {
    monatlichesNettoeinkommen = (haushalt.einkommen as any[]).reduce(
      (sum: number, e: any) => sum + (e.nettoverdienst || 0), 0
    );
  }

  // Monatliche Kreditrate
  let monatlicheKreditrate: number | null = haushalt?.zumutbareKreditrate || null;

  // Bestandskredite
  let bestandskrediteRate: number | null = haushalt?.bestandskrediteRate || null;
  if (!bestandskrediteRate && haushalt?.bestandskredite && Array.isArray(haushalt.bestandskredite)) {
    bestandskrediteRate = (haushalt.bestandskredite as any[]).reduce(
      (sum: number, k: any) => sum + (k.monatlicheRate || 0), 0
    );
  }

  // Total debt service
  const gesamtBelastung = (monatlicheKreditrate || 0) + (bestandskrediteRate || 0);

  // DSTI
  let dsti: number | null = null;
  let dstiProzent: number | null = null;
  let dstiBewertung: Kennzahlen['dstiBewertung'] = 'unvollständig';

  if (monatlichesNettoeinkommen && monatlichesNettoeinkommen > 0 && gesamtBelastung > 0) {
    dsti = gesamtBelastung / monatlichesNettoeinkommen;
    dstiProzent = Math.round(dsti * 100 * 10) / 10; // 1 decimal place

    if (dsti <= 0.35) dstiBewertung = 'gut';
    else if (dsti <= 0.45) dstiBewertung = 'akzeptabel';
    else dstiBewertung = 'kritisch';
  }

  return {
    dsti,
    dstiProzent,
    dstiBewertung,
    dstiDetails: {
      monatlicheKreditrate,
      monatlichesNettoeinkommen,
      bestandskrediteRate,
      gesamtBelastung: gesamtBelastung > 0 ? gesamtBelastung : null,
    },
  };
}

// ============================================================
// LTV Calculation
// ============================================================
function berechneLTV(finanzplan: any, immobilienwert: number | null): Pick<Kennzahlen, 'ltv' | 'ltvProzent' | 'ltvBewertung' | 'ltvDetails'> {
  // Finanzierungsbedarf
  const finanzierungsbedarf =
    finanzplan?.langfrFinanzierungsbedarfBrutto ||
    finanzplan?.langfrFinanzierungsbedarfNetto ||
    finanzplan?.zwischenfinanzierungBrutto ||
    null;

  // Eigenmittelquote
  let eigenmittelQuote: number | null = null;

  let ltv: number | null = null;
  let ltvProzent: number | null = null;
  let ltvBewertung: Kennzahlen['ltvBewertung'] = 'unvollständig';

  if (finanzierungsbedarf && immobilienwert && immobilienwert > 0) {
    ltv = finanzierungsbedarf / immobilienwert;
    ltvProzent = Math.round(ltv * 100 * 10) / 10;

    if (finanzplan?.summeEigenmittel && immobilienwert > 0) {
      eigenmittelQuote = Math.round((finanzplan.summeEigenmittel / immobilienwert) * 100 * 10) / 10;
    }

    if (ltv <= 0.80) ltvBewertung = 'gut';
    else if (ltv <= 0.90) ltvBewertung = 'akzeptabel';
    else ltvBewertung = 'kritisch';
  }

  return {
    ltv,
    ltvProzent,
    ltvBewertung,
    ltvDetails: {
      finanzierungsbedarf,
      immobilienwert,
      eigenmittelQuote,
    },
  };
}

// ============================================================
// Estimated Property Value
// ============================================================
function berechneImmowert(finanzplan: any, objekt: any): Pick<Kennzahlen, 'geschaetzterImmowert' | 'immowertDetails'> {
  // If we have a purchase price, use it directly
  if (finanzplan?.kaufpreis && finanzplan.kaufpreis > 0) {
    return {
      geschaetzterImmowert: finanzplan.kaufpreis,
      immowertDetails: {
        basisPreisProQm: null,
        flaeche: null,
        plz: objekt?.plz || null,
        objektTyp: objekt?.objektTyp || finanzplan?.objektTyp || null,
        baujahr: objekt?.baujahr || null,
        objektTypFaktor: 1,
        baujahrFaktor: 1,
        energieFaktor: 1,
        berechnungsMethode: 'kaufpreis',
      },
    };
  }

  // Estimate based on location, type, size, age
  const plz = objekt?.plz || null;
  const objektTyp = objekt?.objektTyp || finanzplan?.objektTyp || null;
  const baujahr = objekt?.baujahr || null;
  const energiekennzahl = objekt?.energiekennzahl || null;

  // Calculate total area
  const flaeche = berechneGesamtflaeche(objekt);

  if (!plz || !flaeche || flaeche <= 0) {
    return {
      geschaetzterImmowert: null,
      immowertDetails: {
        basisPreisProQm: null,
        flaeche,
        plz,
        objektTyp,
        baujahr,
        objektTypFaktor: 1,
        baujahrFaktor: 1,
        energieFaktor: 1,
        berechnungsMethode: 'nicht_moeglich',
      },
    };
  }

  // Get base price per m²
  const plzPrefix2 = plz.substring(0, 2);
  const basisPreisProQm =
    PRICE_PER_SQM_BY_REGION[plzPrefix2] ||
    PRICE_PER_SQM_BY_REGION[`${plzPrefix2[0]}0_default`] ||
    PRICE_PER_SQM_BY_REGION['default'];

  // Apply multipliers
  const objektTypFaktor = objektTyp
    ? (OBJEKT_TYPE_MULTIPLIERS[objektTyp] || 1.0)
    : 1.0;
  const baujahrFaktor = getBaujahrFactor(baujahr);
  const energieFaktor = getEnergieFactor(energiekennzahl);

  const geschaetzterImmowert = Math.round(
    basisPreisProQm * flaeche * objektTypFaktor * baujahrFaktor * energieFaktor
  );

  return {
    geschaetzterImmowert,
    immowertDetails: {
      basisPreisProQm,
      flaeche,
      plz,
      objektTyp,
      baujahr,
      objektTypFaktor: Math.round(objektTypFaktor * 100) / 100,
      baujahrFaktor: Math.round(baujahrFaktor * 100) / 100,
      energieFaktor: Math.round(energieFaktor * 100) / 100,
      berechnungsMethode: 'schaetzung',
    },
  };
}

// Calculate total usable area from object data
function berechneGesamtflaeche(objekt: any): number | null {
  if (!objekt) return null;

  // Use grundstuecksflaeche if no room details available
  const roomAreas = [
    objekt.flaecheKeller,
    objekt.flaecheErdgeschoss,
    objekt.flaecheObergeschoss,
    objekt.flaecheWeiteresOg,
    objekt.flaecheDachgeschoss,
  ].filter((v: any) => v && v > 0);

  if (roomAreas.length > 0) {
    // Sum living area (exclude Keller at 50% for valuation)
    let totalArea = 0;
    if (objekt.flaecheErdgeschoss) totalArea += objekt.flaecheErdgeschoss;
    if (objekt.flaecheObergeschoss) totalArea += objekt.flaecheObergeschoss;
    if (objekt.flaecheWeiteresOg) totalArea += objekt.flaecheWeiteresOg;
    if (objekt.flaecheDachgeschoss) totalArea += objekt.flaecheDachgeschoss;
    if (objekt.flaecheKeller) totalArea += objekt.flaecheKeller * 0.5;
    // Add partial areas
    if (objekt.flaecheLoggia) totalArea += objekt.flaecheLoggia * 0.5;
    if (objekt.flaecheBalkon) totalArea += objekt.flaecheBalkon * 0.25;
    if (objekt.flaecheTerrasse) totalArea += objekt.flaecheTerrasse * 0.25;
    return Math.round(totalArea * 10) / 10;
  }

  // Fallback: use Grundstücksfläche
  if (objekt.grundstuecksflaeche && objekt.grundstuecksflaeche > 0) {
    return objekt.grundstuecksflaeche;
  }

  return null;
}
