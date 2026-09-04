const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const source = path.join(root, 'build', 'icon.svg');
  const target = path.join(root, 'build', 'icon.png');
  const window = new BrowserWindow({
    width: 512,
    height: 512,
    useContentSize: true,
    show: false,
    transparent: true,
    frame: false,
  });
  await window.loadFile(source);
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.writeFileSync(target, image.toPNG());
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
