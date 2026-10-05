/* One-off: sample colors from assets/icon.png via Electron's nativeImage. */
const { app, nativeImage } = require('electron');

app.whenReady().then(() => {
  const img = nativeImage.createFromPath('assets/icon.png');
  const { width, height } = img.getSize();
  const bmp = img.getBitmap(); // BGRA
  const px = (x, y) => {
    const xi = Math.min(width - 1, Math.round(x));
    const yi = Math.min(height - 1, Math.round(y));
    const j = (yi * width + xi) * 4;
    const hex = (v) => v.toString(16).padStart(2, '0');
    return `#${hex(bmp[j + 2])}${hex(bmp[j + 1])}${hex(bmp[j])}`;
  };
  console.log('size', width, 'x', height);
  // Tile samples: center-bottom area away from the F and ornaments
  console.log('tile-mid   :', px(width * 0.5, height * 0.55));
  console.log('tile-corner:', px(width * 0.08, height * 0.5));
  console.log('tile-top   :', px(width * 0.5, height * 0.12));
  console.log('figure (F) :', px(width * 0.42, height * 0.45));
  app.exit(0);
});
