/* One-off: rasterize an HTML contact sheet of SVG logo proposals to PNG. */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const htmlFile = process.argv[2];
const outFile = process.argv[3];
const width = parseInt(process.argv[4] ?? '1200', 10);
const height = parseInt(process.argv[5] ?? '800', 10);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width, height, show: false });
  await win.loadFile(path.resolve(htmlFile));
  await new Promise((r) => setTimeout(r, 500)); // settle fonts/SVG paint
  const img = await win.webContents.capturePage();
  require('node:fs').writeFileSync(path.resolve(outFile), img.toPNG());
  app.exit(0);
});
