/* ═══════════════════════════════════════
   TC CREATOR — main.js
   Electron hlavní proces
═══════════════════════════════════════ */

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs   = require('fs');

let mainWindow;

/* ── VYTVOŘENÍ OKNA ── */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 700,
    minHeight: 500,
    title: 'TC Creator',
    backgroundColor: '#141414',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  Menu.setApplicationMenu(null);

  // F12 — manuální otevření DevTools (pro debugování)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

/* ═══════════════════════════════════════
   IPC — komunikace s renderer procesem
═══════════════════════════════════════ */

/* ── OTEVŘÍT SOUBOR ── */
ipcMain.handle('open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Otevřít projekt',
    filters: [{ name: 'TC Creator projekt', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;

  const filePath = result.filePaths[0];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return { filePath, data };
  } catch (e) {
    return { error: 'Soubor nelze načíst nebo má neplatný formát.' };
  }
});

/* ── ULOŽIT SOUBOR ── */
ipcMain.handle('save-file', async (event, { filePath, data }) => {
  try {
    // Pokud filePath není zadán, ptáme se kde uložit
    let savePath = filePath;
    if (!savePath) {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Uložit projekt',
        defaultPath: `${data.project || 'projekt'}.json`,
        filters: [{ name: 'TC Creator projekt', extensions: ['json'] }]
      });
      if (result.canceled) return { canceled: true };
      savePath = result.filePath;
    }

    fs.writeFileSync(savePath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true, filePath: savePath };
  } catch (e) {
    return { error: 'Soubor se nepodařilo uložit.' };
  }
});

/* ── EXPORT CSV ── */
ipcMain.handle('export-csv', async (event, { defaultName, content }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Exportovat do CSV',
    defaultPath: `${defaultName || 'export'}.csv`,
    filters: [{ name: 'CSV soubor', extensions: ['csv'] }]
  });
  if (result.canceled) return { canceled: true };

  try {
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return { success: true };
  } catch (e) {
    return { error: 'CSV se nepodařilo exportovat.' };
  }
});

/* ── EXPORT JSON ── */
ipcMain.handle('export-json', async (event, { defaultName, data }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Exportovat do JSON',
    defaultPath: `${defaultName || 'export'}.json`,
    filters: [{ name: 'JSON soubor', extensions: ['json'] }]
  });
  if (result.canceled) return { canceled: true };

  try {
    fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  } catch (e) {
    return { error: 'JSON se nepodařilo exportovat.' };
  }
});

/* ── EXPORT XLSX ── */
ipcMain.handle('export-xlsx', async (event, { defaultName, rows, headers, dropdownValues }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Exportovat do XLSX',
    defaultPath: `${defaultName || 'export'}.xlsx`,
    filters: [{ name: 'Excel sešit', extensions: ['xlsx'] }]
  });
  if (result.canceled) return { canceled: true };

  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Test Cases');

    // Hlavička
    ws.addRow(headers);
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D5016' } };
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.height = 18;

    // Data řádky
    rows.forEach(row => ws.addRow(row));

    // Nastavit šířku sloupců
    ws.columns.forEach((col, i) => {
      const maxLen = Math.max(
        headers[i] ? headers[i].toString().length : 10,
        ...rows.map(r => (r[i] ? r[i].toString().split('\n')[0].length : 0)).slice(0, 50)
      );
      col.width = Math.min(Math.max(maxLen + 2, 10), 60);
    });

    // Zalamování textu pro víceřádkové buňky
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      row.alignment = { wrapText: true, vertical: 'top' };
    });

    // Dropdown validace pro sloupec "Výsledek testu" (najdi index)
    if (dropdownValues && dropdownValues.col !== undefined) {
      const colLetter = String.fromCharCode(65 + dropdownValues.col);
      const formula   = `"${dropdownValues.values.join(',')}"`;
      for (let r = 2; r <= rows.length + 1; r++) {
        ws.getCell(`${colLetter}${r}`).dataValidation = {
          type: 'list', allowBlank: false,
          formulae: [formula],
          showDropDown: false
        };
      }
    }

    await wb.xlsx.writeFile(result.filePath);
    return { success: true };
  } catch (e) {
    return { error: `XLSX se nepodařilo exportovat: ${e.message}` };
  }
});

/* ── NAČÍST POSLEDNÍ SOUBOR ── */
ipcMain.handle('load-last-file', async (event, filePath) => {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return { filePath, data };
  } catch (e) {
    return null;
  }
});

/* ── TICHÁ AUTOMATICKÁ ZÁLOHA (bez dialogu) ──
   Ukládá do podsložky ".tc_backups" vedle aktuálně otevřeného souboru.
   Udržuje jen posledních MAX_SILENT_BACKUPS záloh — starší se smažou. */
const MAX_SILENT_BACKUPS = 5;

ipcMain.handle('silent-backup', async (event, { filePath, data }) => {
  if (!filePath) return { skipped: true };
  try {
    const dir      = path.dirname(filePath);
    const baseName = path.basename(filePath, path.extname(filePath));
    const backupDir = path.join(dir, '.tc_backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = `${baseName}_autosave_`;
    const backupPath = path.join(backupDir, `${prefix}${stamp}.json`);

    fs.writeFileSync(backupPath, JSON.stringify(data, null, 2), 'utf-8');

    // Rotace — nech jen posledních MAX_SILENT_BACKUPS souborů tohoto projektu
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .sort(); // ISO timestamp v názvu → lexikografické řazení = chronologické

    while (files.length > MAX_SILENT_BACKUPS) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(backupDir, oldest)); } catch (e) { /* ignore */ }
    }

    return { success: true, filePath: backupPath };
  } catch (e) {
    return { error: 'Tichou zálohu se nepodařilo vytvořit.' };
  }
});
