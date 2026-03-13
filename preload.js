/**
 * Preload — bridges renderer and main process.
 * IMPORTANT: Do NOT import webUtils here. It was introduced in Electron 32.
 * This app targets Electron 29, where webUtils does not exist.
 * Drag-drop file paths are handled via the 'get-file-path' IPC channel instead.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── File operations ────────────────────────────────────────────────────────
  pickCSV:        (type)        => ipcRenderer.invoke('pick-csv', type),
  pickFolder:     (type)        => ipcRenderer.invoke('pick-folder', type),
  // Drag-drop: renderer reads file bytes, sends buffer to main for parsing
  // (avoids needing file.path which was removed in Electron 32+)
  parseBuffer:    (buf, name, type) => ipcRenderer.invoke('parse-buffer', buf, name, type),

  // ── Data ──────────────────────────────────────────────────────────────────
  savePeriod:     (payload)     => ipcRenderer.invoke('save-period', payload),
  getPeriods:     ()            => ipcRenderer.invoke('get-periods'),
  getCumulative:  ()            => ipcRenderer.invoke('get-cumulative'),
  getMetrics:     (opts)        => ipcRenderer.invoke('get-metrics', opts),
  getPeriodLabels:(viewBy)      => ipcRenderer.invoke('get-period-labels', viewBy),
  deletePeriod:   (id)          => ipcRenderer.invoke('delete-period', id),
  patchPeriod:    (payload)     => ipcRenderer.invoke('patch-period', payload),
  whatIf:         (payload)     => ipcRenderer.invoke('whatif', payload),
  exportExcel:    (payload)     => ipcRenderer.invoke('export-excel', payload),
  exportCSV:      (payload)     => ipcRenderer.invoke('export-csv', payload),
});
