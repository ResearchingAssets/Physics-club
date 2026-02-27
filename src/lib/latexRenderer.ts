import puppeteer from 'puppeteer';

// Escape HTML safely
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
} // This function takes a LaTeX string as input, renders it using KaTeX in a headless browser, and returns the rendered image as a Buffer. The font size is dynamically adjusted based on the length of the input text to ensure readability. The rendered content is styled with a grayish background and white text, and the image is cropped to fit the content tightly.

export async function renderLatex(latexText: string): Promise<Buffer> {
  // Calculate font size based on text length
  // Shorter text gets larger font, longer text gets smaller font
  const textLength = latexText.length;
  let fontSize: number;

  if (textLength <= 20) {
    fontSize = 2.4;
  } else if (textLength <= 40) {
    fontSize = 2.0;
  } else if (textLength <= 80) {
    fontSize = 1.6;
  } else if (textLength <= 150) {
    fontSize = 1.2;
  } else {
    fontSize = 0.9;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox']
  }); // Launch a headless browser instance

  const page = await browser.newPage();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Physics Club LaTeX</title>
  
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.33/dist/katex.min.css" crossorigin="anonymous">
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.33/dist/katex.min.js" crossorigin="anonymous"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.33/dist/contrib/auto-render.min.js" crossorigin="anonymous"></script>

  <style>
    body { 
      margin: 0; 
      padding: 20px; 
      background: #2d2d2d; 
      display: flex;
      justify-content: center;
      align-items: center;
    }
    #content {
      background: #2d2d2d;           /* grayish background */
      color: #ffffff;                /* white text */
      padding: 16px 24px;            /* tight padding */
      border-radius: 18px;
      font-size: ${fontSize}em;      /* dynamic font size */
      line-height: 1.3;              /* tighter line height */
      text-align: center;
      width: fit-content;            /* tight fit */
      max-width: 900px;
      display: inline-block;
      word-wrap: break-word;
    }
  </style>
</head>
<body>
  <div id="content">${escapeHtml(latexText)}</div>

  <script>
    window.addEventListener('load', () => {
      renderMathInElement(document.getElementById('content'), {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true }
        ],
        throwOnError: false
      });
    });
  </script>
</body>
</html>`;

  await page.setContent(html, { waitUntil: 'networkidle0' }); // Wait for all resources to load

  const contentElement = await page.$('#content'); // Select the content area
  const imageData = await contentElement!.screenshot({ type: 'png' }); // Capture only the content area

  await browser.close(); // Close the browser
  return Buffer.from(imageData); // Return the image as a Buffer
}