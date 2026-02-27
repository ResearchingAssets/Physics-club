import { GoogleSpreadsheet } from 'google-spreadsheet';      // Main library to talk to Google Sheets
import { JWT } from 'google-auth-library';                   // New way to create service-account auth (v5+ requirement)
import fs from 'fs';                                         // Built-in: read files from disk
import path from 'path';                                     // Built-in: handle file paths correctly on Windows/Mac
import { DateTime } from 'luxon';

// Path to your downloaded credentials.json (in project root)
const credsPath = path.join(process.cwd(), 'credentials.json');  // Find credentials.json no matter where you run the bot

// Load the JSON file once at startup
const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));    // Parse the service-account keys Google gave you

// Create reusable JWT auth object (this replaces the old useServiceAccountAuth)
export const serviceAccountAuth = new JWT({
  email: creds.client_email,                                     // Service account email from JSON
  key: creds.private_key,                                        // Private key from JSON
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],      // Only needs Sheets access
});

// Function to get the full spreadsheet document
export async function getMainSheet() {
  // New constructor: (sheetId, auth) — this was causing "Expected 2-3 arguments, got 1"
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID!, serviceAccountAuth);

  await doc.loadInfo();                                          // Fetch metadata (title, sheets list, etc.)
  console.log(`Connected to sheet: ${doc.title}`);            // Confirmation in terminal
  return doc;
}

// Helper: returns the first tab (your problem list) — change index if needed
export async function getProblemsSheet() {
  const doc = await getMainSheet();                              // Get the doc first
  return doc.sheetsByIndex[0];                                   // sheetsByIndex[0] = tab 1
}

// Main function: get problem by date (input can be "today" or a specific date string)
// Fetch problem by date (YYYY-MM-DD or "today" in IST timezone)
export async function getProblemByDate(inputDate: string = 'today') {
  const sheet = await getProblemsSheet();
  const rows = await sheet.getRows();

  let targetDate: string;

  if (inputDate.toLowerCase() === 'today') {
    // Use Luxon for IST timezone handling
    const istNow = DateTime.now().setZone('Asia/Kolkata');
    const istNoon = istNow.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });

    // If current time is before 12 PM IST, use yesterday's date
    if (istNow < istNoon) {
      const istYesterday = istNow.minus({ days: 1 });
      targetDate = istYesterday.toFormat('yyyy-MM-dd');
    } else {
      targetDate = istNow.toFormat('yyyy-MM-dd');
    }
  } else {
    targetDate = inputDate.trim();
  }

  for (const row of rows) {
    const rowDate = row.get('Date')?.toString().trim();
    if (rowDate === targetDate) {
      return {
        number: row.get('Number'),
        date: rowDate,
        day: row.get('Day'),
        userid: row.get('User ID'),
        curator: row.get('Curator'),
        source: row.get('Source'),
        genre: row.get('Genre'),
        difficulty: row.get('Difficulty'),
        baseScore: row.get('Base Score'),
        problemLatex: row.get('Problem Statement'),
        hint1: row.get('Hint 1'),
        answer: row.get('Answer'),
        solution: row.get('Solution'),
      };
    }
  }
  throw new Error(`No problem found for date: ${targetDate}`);
}

// Additional function to get problem by number (if you want to fetch by problem number instead of date)
export async function getProblemByNumber(problemNumber: string) {
  const sheet = await getProblemsSheet();
  const rows = await sheet.getRows();

  const numStr = problemNumber.trim();

  for (const row of rows) {
    const rowNum = row.get('Number')?.toString().trim();
    if (rowNum === numStr) {
      return {
        number: numStr,
        problemLatex: row.get('Problem Statement') || '',
        baseScore: row.get('Base Score') || '10',  // ← Added, default 10 if missing
      };
    }
  }
  throw new Error(`Problem #${problemNumber} not found`);
}