/* One-off: rasterize an SVG to an exact-size PNG via Electron capturePage. */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const svgFile = process.argv[2];
const outFile = process.argv[3];
const size = parseInt(process.argv[4] ?? '1024', 10);

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.resolve(svgFile), 'utf8');
  const html = `<!doctype html><body style="margin:0;overflow:hidden"><div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `)}</div></body>`;
  const win = new BrowserWindow({
    width: size,
    height: size,
    useContentSize: true,
    frame: false,
    show: false,
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.resolve(outFile), img.toPNG());
  app.exit(0);
});
