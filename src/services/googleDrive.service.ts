// src/services/googleDrive.service.ts
// 
// WICHTIG: Nutzt OAuth2 statt Service Account, weil Service Accounts
// kein Speicherkontingent bei normalem Gmail haben.
//
// Benötigte ENV Variablen:
//   GOOGLE_DRIVE_CLIENT_ID
//   GOOGLE_DRIVE_CLIENT_SECRET  
//   GOOGLE_DRIVE_REFRESH_TOKEN
//   GOOGLE_DRIVE_FOLDER_ID
//
import { google } from 'googleapis';
import { Readable } from 'stream';

let driveClient: any = null;

function getDrive() {
  if (!driveClient) {
    const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Google Drive OAuth2 credentials not configured (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN)');
    }

    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });

    driveClient = google.drive({ version: 'v3', auth });
  }
  return driveClient;
}

const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '';

// ============================================================
// Helper: Capitalize name properly (Mix-Case)
// "MATEJ" → "Matej", "knežević" → "Knežević"
// ============================================================
function capitalizeName(name: string): string {
  if (!name) return name;
  return name
    .split(/(\s+|-)/g)
    .map(part => {
      if (part.match(/^[\s-]+$/)) return part; // Keep separators
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join('');
}

// ============================================================
// Numbered Customer Folder Creation
// ============================================================

export async function createCustomerFolder(
  firstName: string,
  lastName: string,
  rootFolderId?: string,
): Promise<{ folderId: string; folderUrl: string }> {
  const drive = getDrive();
  const parentId = rootFolderId || FOLDER_ID;

  // 1. List all existing folders to find highest number
  let allFolders: any[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 200,
      pageToken,
    });
    allFolders = allFolders.concat(res.data.files || []);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  // 2. Find highest number
  let maxNumber = 0;
  for (const folder of allFolders) {
    const match = folder.name?.match(/^(\d+)[_\-]/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNumber) maxNumber = num;
    }
  }

  const nextNumber = maxNumber + 1;

  // Mix-Case: "MATEJ KNEŽEVIĆ" → "Matej Knežević"
  const formattedFirst = capitalizeName(firstName.trim());
  const formattedLast = capitalizeName(lastName.trim());
  const fullName = `${formattedFirst} ${formattedLast}`.trim();
  const folderName = `${nextNumber}_${fullName}`;

  console.log(`[GDrive] Creating customer folder: ${folderName} in ${rootFolderId ? 'custom' : 'default'} root`);

  // 3. Create main customer folder
  const mainFolder = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });

  const folderId = mainFolder.data.id!;

  // 4. Create subfolders
  await Promise.all([
    drive.files.create({
      requestBody: {
        name: 'Archiv',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [folderId],
      },
    }),
    drive.files.create({
      requestBody: {
        name: 'Nachreichung',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [folderId],
      },
    }),
  ]);

  const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;
  console.log(`[GDrive] ✅ Created: ${folderName} + Archiv + Nachreichung`);

  return { folderId, folderUrl };
}

// ============================================================
// Image → PDF Conversion
// Converts JPG/PNG/JPEG images to PDF before upload
// ============================================================

async function convertImageToPdf(
  fileBuffer: Buffer,
  mimeType: string,
): Promise<{ pdfBuffer: Buffer; pdfMimeType: string }> {
  const { PDFDocument } = await import('pdf-lib');
  const sharp = (await import('sharp')).default;

  // Convert image to JPEG with sharp (normalizes any format)
  const jpegBuffer = await sharp(fileBuffer)
    .jpeg({ quality: 90 })
    .toBuffer();

  // Get image dimensions
  const metadata = await sharp(fileBuffer).metadata();
  const imgWidth = metadata.width || 800;
  const imgHeight = metadata.height || 600;

  // Create PDF
  const pdfDoc = await PDFDocument.create();

  // Use A4 as base, but scale to fit image proportionally
  const pageWidth = 595.28;  // A4 width in points
  const pageHeight = 841.89; // A4 height in points

  // Calculate scale to fit image on page with margins
  const margin = 40;
  const availableWidth = pageWidth - 2 * margin;
  const availableHeight = pageHeight - 2 * margin;

  const scaleX = availableWidth / imgWidth;
  const scaleY = availableHeight / imgHeight;
  const scale = Math.min(scaleX, scaleY, 1); // Don't upscale

  const scaledWidth = imgWidth * scale;
  const scaledHeight = imgHeight * scale;

  const page = pdfDoc.addPage([pageWidth, pageHeight]);

  const jpegImage = await pdfDoc.embedJpg(jpegBuffer);

  // Center the image on the page
  const x = (pageWidth - scaledWidth) / 2;
  const y = (pageHeight - scaledHeight) / 2;

  page.drawImage(jpegImage, {
    x,
    y,
    width: scaledWidth,
    height: scaledHeight,
  });

  const pdfBytes = await pdfDoc.save();

  return {
    pdfBuffer: Buffer.from(pdfBytes),
    pdfMimeType: 'application/pdf',
  };
}

// ============================================================
// Helper: Check if mime type is an image
// ============================================================
function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/') && mimeType !== 'image/heic' && mimeType !== 'image/heif';
}

// ============================================================
// File Upload to Customer Folder
// Filename format: "1. Vorname Nachname Dokumenttyp.ext"
// Images are auto-converted to PDF before upload
// ============================================================

export interface UploadResult {
  fileId: string;
  webViewLink: string;
}

export async function uploadFileToCustomerFolder(
  fileBuffer: Buffer,
  filename: string,
  mimeType: string,
  targetFolderId: string,
  documentType?: string,
  customerName?: string,
): Promise<UploadResult> {
  const drive = getDrive();

  // ── Upload raw/original file to "Archiv" subfolder ──
  try {
    const archivFolderId = await getOrCreateSubfolderInParent(drive, targetFolderId, 'Archiv');
    const rawStream = new Readable();
    rawStream.push(fileBuffer);
    rawStream.push(null);

    await drive.files.create({
      requestBody: {
        name: filename,
        parents: [archivFolderId],
      },
      media: {
        mimeType,
        body: rawStream,
      },
      fields: 'id',
    });
    console.log(`[GDrive] Archiv: ${filename} → Archiv subfolder`);
  } catch (err: any) {
    console.error(`[GDrive] ⚠️ Archiv upload failed (non-fatal): ${err.message}`);
  }

  // ── Convert images to PDF for the main folder ──
  let uploadBuffer = fileBuffer;
  let uploadMimeType = mimeType;
  let uploadFilename = filename;

  if (isImageMimeType(mimeType)) {
    try {
      console.log(`[GDrive] Converting image to PDF: ${filename}`);
      const { pdfBuffer, pdfMimeType } = await convertImageToPdf(fileBuffer, mimeType);
      uploadBuffer = pdfBuffer;
      uploadMimeType = pdfMimeType;
      // Change extension to .pdf
      uploadFilename = filename.replace(/\.(jpg|jpeg|png|gif|webp|bmp|tiff?)$/i, '.pdf');
      console.log(`[GDrive] Converted: ${filename} → ${uploadFilename} (${pdfBuffer.length} bytes)`);
    } catch (err: any) {
      console.error(`[GDrive] ⚠️ Image→PDF conversion failed, uploading original: ${err.message}`);
      // Fallback: upload original image if conversion fails
    }
  }

  // Find highest existing file number in folder (based on "N." prefix)
  let maxFileNumber = 0;
  try {
    const res = await drive.files.list({
      q: `'${targetFolderId}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
      pageSize: 100,
    });
    const existingFiles = res.data.files || [];
    for (const file of existingFiles) {
      const match = file.name?.match(/^(\d+)\./);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxFileNumber) maxFileNumber = num;
      }
    }
  } catch (err) {
    // If listing fails, start from 1
  }

  const nextFileNumber = maxFileNumber + 1;

  // Build filename: "1. Matej Knežević Lohnzettel.pdf"
  const ext = uploadFilename.includes('.') ? uploadFilename.substring(uploadFilename.lastIndexOf('.')) : '';
  let uploadName: string;

  if (customerName && documentType) {
    uploadName = `${nextFileNumber}. ${customerName} ${documentType}${ext}`;
  } else if (customerName) {
    uploadName = `${nextFileNumber}. ${customerName}${ext}`;
  } else {
    uploadName = `${nextFileNumber}. ${uploadFilename}`;
  }

  const stream = new Readable();
  stream.push(uploadBuffer);
  stream.push(null);

  console.log(`[GDrive] Uploading: ${uploadName} → folder ${targetFolderId}`);

  const response = await drive.files.create({
    requestBody: {
      name: uploadName,
      parents: [targetFolderId],
    },
    media: {
      mimeType: uploadMimeType,
      body: stream,
    },
    fields: 'id, webViewLink',
  });

  const fileId = response.data.id!;
  const webViewLink = response.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

  console.log(`[GDrive] Uploaded: ${uploadName} (${fileId})`);
  return { fileId, webViewLink };
}

// ============================================================
// Helper: Find or create a subfolder inside a parent folder
// ============================================================
async function getOrCreateSubfolderInParent(
  drive: any,
  parentFolderId: string,
  subfolderName: string,
): Promise<string> {
  // Check if subfolder already exists
  const existing = await drive.files.list({
    q: `'${parentFolderId}' in parents and name='${subfolderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    pageSize: 1,
  });

  if (existing.data.files && existing.data.files.length > 0) {
    return existing.data.files[0].id!;
  }

  // Create subfolder
  const created = await drive.files.create({
    requestBody: {
      name: subfolderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id',
  });

  console.log(`[GDrive] Created subfolder: ${subfolderName} in ${parentFolderId}`);
  return created.data.id!;
}

// ============================================================
// Legacy: Upload by customer name (backward compatible)
// ============================================================

const subfolderCache: Record<string, string> = {};

async function getOrCreateSubfolder(folderName: string): Promise<string> {
  if (subfolderCache[folderName]) return subfolderCache[folderName];

  const drive = getDrive();
  const existing = await drive.files.list({
    q: `name='${folderName.replace(/'/g, "\\'")}' and '${FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
  });

  if (existing.data.files && existing.data.files.length > 0) {
    const id = existing.data.files[0].id!;
    subfolderCache[folderName] = id;
    return id;
  }

  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [FOLDER_ID],
    },
    fields: 'id',
  });

  const id = created.data.id!;
  subfolderCache[folderName] = id;
  return id;
}

export async function uploadFile(
  fileBuffer: Buffer,
  filename: string,
  mimeType: string,
  customerName?: string | null,
): Promise<UploadResult> {
  const drive = getDrive();
  const subfolderName = customerName || 'Nicht zugeordnet';
  const parentFolderId = await getOrCreateSubfolder(subfolderName);

  const stream = new Readable();
  stream.push(fileBuffer);
  stream.push(null);

  const response = await drive.files.create({
    requestBody: { name: filename, parents: [parentFolderId] },
    media: { mimeType, body: stream },
    fields: 'id, webViewLink',
  });

  const fileId = response.data.id!;
  const webViewLink = response.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
  return { fileId, webViewLink };
}

// ============================================================
// File Operations
// ============================================================

export async function moveFile(fileId: string, newFolderId: string): Promise<void> {
  const drive = getDrive();
  const file = await drive.files.get({ fileId, fields: 'parents' });
  const previousParents = (file.data.parents || []).join(',');

  await drive.files.update({
    fileId,
    addParents: newFolderId,
    removeParents: previousParents,
    fields: 'id, parents',
  });
}

export async function deleteFile(fileId: string): Promise<void> {
  const drive = getDrive();
  await drive.files.delete({ fileId });
}

export function resetClient() {
  driveClient = null;
}

export async function checkConnection(): Promise<boolean> {
  try {
    const drive = getDrive();
    console.log(`[GDrive] Testing connection to folder: ${FOLDER_ID}`);
    const res = await drive.files.get({ fileId: FOLDER_ID, fields: 'id, name' });
    console.log(`[GDrive] ✅ Connected: ${res.data.name}`);
    return true;
  } catch (err: any) {
    const errDetail = err.response?.data?.error || err.message;
    console.error(`[GDrive] ❌ Connection failed:`, JSON.stringify(errDetail));
    // Reset cached client so next call creates a fresh one
    driveClient = null;
    return false;
  }
}