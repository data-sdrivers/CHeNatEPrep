// ============================================================
//  CHNatPrep CBT Platform
//  Developed by DSD (Data Solution Drivers)
//  DB.gs — Google Sheets data-access layer
//
//  Design principles:
//  · One spreadsheet reference per execution (cached in _ss).
//  · getAll() reads an entire sheet in a single API call.
//  · batchInsert() writes N rows in one setValues() call.
//  · updateRow() patches a single row by key column — no
//    full-sheet rewrite needed.
// ============================================================

var DB = (function () {

  var _ss = null;

  function _spreadsheet() {
    if (!_ss) _ss = SpreadsheetApp.getActiveSpreadsheet();
    return _ss;
  }

  function sheet(name) {
    return _spreadsheet().getSheetByName(name);
  }

  // ── Read ─────────────────────────────────────────────────
  function getAll(sheetName) {
    var s = sheet(sheetName);
    if (!s) return [];
    var data = s.getDataRange().getValues();
    if (data.length < 2) return [];
    var headers = data[0];
    return data.slice(1).map(function (row) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    });
  }

  function find(sheetName, pred)    { return getAll(sheetName).filter(pred); }
  function findOne(sheetName, pred) {
    var rows = getAll(sheetName);
    for (var i = 0; i < rows.length; i++) if (pred(rows[i])) return rows[i];
    return null;
  }

  // ── Write: single row ────────────────────────────────────
  function insert(sheetName, obj) {
    var s       = sheet(sheetName);
    var headers = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
    s.appendRow(headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; }));
    return obj;
  }

  // ── Write: N rows in one API call ────────────────────────
  function batchInsert(sheetName, rows) {
    if (!rows || !rows.length) return 0;
    var s       = sheet(sheetName);
    var headers = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
    var matrix  = rows.map(function (obj) {
      return headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
    });
    s.getRange(s.getLastRow() + 1, 1, matrix.length, headers.length).setValues(matrix);
    return rows.length;
  }

  // ── Write: targeted patch by key value ──────────────────
  function updateRow(sheetName, keyCol, keyVal, changes) {
    var s       = sheet(sheetName);
    var data    = s.getDataRange().getValues();
    var headers = data[0];
    var keyIdx  = headers.indexOf(keyCol);
    if (keyIdx === -1) return 0;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][keyIdx]) === String(keyVal)) {
        Object.keys(changes).forEach(function (k) {
          var ci = headers.indexOf(k);
          if (ci !== -1) data[i][ci] = changes[k];
        });
        s.getRange(i + 1, 1, 1, headers.length).setValues([data[i]]);
        return 1;
      }
    }
    return 0;
  }

  // ── Delete ───────────────────────────────────────────────
  function deleteRows(sheetName, pred) {
    var s       = sheet(sheetName);
    var data    = s.getDataRange().getValues();
    var headers = data[0];
    var deleted = 0;
    for (var i = data.length - 1; i >= 1; i--) {
      var row = {};
      headers.forEach(function (h, j) { row[h] = data[i][j]; });
      if (pred(row)) { s.deleteRow(i + 1); deleted++; }
    }
    return deleted;
  }

  // ── Config ───────────────────────────────────────────────
  function getConfig(key) {
    var row = findOne(SHEET.CONFIG, function (r) { return r.Key === key; });
    return row ? row.Value : null;
  }

  // ── ID generation ────────────────────────────────────────
  function newId(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.floor(Math.random() * 99999);
  }

  return { sheet, getAll, find, findOne, insert, batchInsert, updateRow, deleteRows, getConfig, newId };
})();
