// ============================================================
//  CHeNatEPrep Platform
//  Developed by DSD (Data Solution Drivers)
//  Code.gs — Web-app entry, server functions, DB bootstrap
// ============================================================

// Sheet name constants shared across all modules
var SHEET = {
  USERS:     'Users',
  PAPERS:    'Papers',
  QUESTIONS: 'Questions',
  ATTEMPTS:  'Attempts',
  RESPONSES: 'Responses',
  AUTOSAVES: 'Autosaves',
  CONFIG:    'Config'
};

// ── Entry point ──────────────────────────────────────────────
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('CHeNatEPrep Platform');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ── Safety wrapper ───────────────────────────────────────────
// All server_ functions pass through here so any thrown error
// returns a clean {ok:false, error:...} rather than crashing.
function _safe(fn) {
  try {
    var r = fn();
    if (r === undefined || r === null) return { ok: false, error: 'No data returned.' };
    return JSON.parse(JSON.stringify(r));  // strips Dates/undefined
  } catch (e) {
    Logger.log('[_safe] ' + e.message);
    return { ok: false, error: e.message };
  }
}

// ── Combined bootstrap ───────────────────────────────────────
// Single round-trip: identifies user AND checks for an active
// exam session. Halves cold-start latency vs two sequential calls.
function server_bootstrap() {
  return _safe(function () {
    var auth = Auth.getCurrentUser();
    if (!auth.ok) return { ok: false, reason: 'unauthenticated' };
    var user = auth.user;
    if (user.role === 'admin') return { ok: true, user: user, resume: null };
    var resume = Exam.resumeExam({ email: user.email });
    return {
      ok:           true,
      user:         user,
      resume:       resume.ok ? resume : null,
      resumeReason: resume.reason || null
    };
  });
}

// ── Auth ─────────────────────────────────────────────────────
function server_login(data)          { return _safe(function(){ return Auth.login(data); }); }
function server_register(data)       { return _safe(function(){ return Auth.register(data); }); }
function server_setPassword(data)    { return _safe(function(){ return Auth.setPassword(data); }); }
function server_changePassword(data) { return _safe(function(){ return Auth.changePassword(data); }); }
function server_resetPassword(data)  { return _safe(function(){ return Auth.resetPassword(data); }); }
function server_submitContact(data)  { return _safe(function(){ return Auth.submitContact(data); }); }

// ── Exam ─────────────────────────────────────────────────────
function server_getPapers(data)        { return _safe(function(){ return Exam.getPapers(data || {}); }); }
function server_startExam(data)        { return _safe(function(){ return Exam.startExam(data); }); }
function server_submitExam(data)       { return _safe(function(){ return Exam.submitExam(data); }); }
function server_autosaveExam(data)     { return _safe(function(){ return Exam.autosaveExam(data); }); }
function server_resumeExam(data)       { return _safe(function(){ return Exam.resumeExam(data); }); }
function server_checkPaperActive(data) { return _safe(function(){ return Exam.checkPaperActive(data); }); }

// ── Student ──────────────────────────────────────────────────
function server_getMyAttempts(data)    { return _safe(function(){ return Student.getMyAttempts(data); }); }
function server_getAttemptResult(data) { return _safe(function(){ return Student.getAttemptResult(data); }); }
function server_getAnalytics(data)     { return _safe(function(){ return Student.getAnalytics(data); }); }

// ── Admin ────────────────────────────────────────────────────
function server_addPaper(data)        { return _safe(function(){ return Admin.addPaper(data); }); }
function server_togglePaper(data)     { return _safe(function(){ return Admin.togglePaper(data); }); }
function server_deletePaper(data)     { return _safe(function(){ return Admin.deletePaper(data); }); }
function server_addQuestion(data)     { return _safe(function(){ return Admin.addQuestion(data); }); }
function server_importQuestions(data) { return _safe(function(){ return Admin.importQuestions(data); }); }
function server_deleteQuestion(data)  { return _safe(function(){ return Admin.deleteQuestion(data); }); }
function server_getQuestions(data)    { return _safe(function(){ return Admin.getQuestions(data); }); }
function server_getAdminStats()       { return _safe(function(){ return Admin.getStats(); }); }
function server_getAllUsers()         { return _safe(function(){ return Admin.getAllUsers(); }); }
function server_getAllAttempts()      { return _safe(function(){ return Admin.getAllAttempts(); }); }

// ── Utilities ────────────────────────────────────────────────
function _getSpreadsheet() {
  try { return SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  return SpreadsheetApp.openById('PASTE_YOUR_SPREADSHEET_ID_HERE');
}

function _alert(title, msg) {
  Logger.log('[CHeNatEPrep] ' + title + ': ' + msg);
  try { SpreadsheetApp.getUi().alert(title, msg, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { /* no UI context — already logged */ }
}

// ── Sheets menu ──────────────────────────────────────────────
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('⚙️ CHeNatEPrep')
      .addItem('Initialise Database', 'initializeSpreadsheet')
      .addSeparator()
      .addItem('Show Web App URL',    'showDeploymentUrl')
      .addToUi();
  } catch (e) { Logger.log('onOpen: ' + e.message); }
}

function showDeploymentUrl() {
  var url = '';
  try { url = ScriptApp.getService().getUrl(); } catch (e) { url = 'Not deployed'; }
  _alert('CHeNatEPrep URL', url || 'Deploy: Deploy > New Deployment > Web App');
}

// ── Database bootstrap ───────────────────────────────────────
function initializeSpreadsheet() {
  var ss  = _getSpreadsheet();
  var log = [];

  var schemas = {
    Users:     ['Email','FullName','Cadre','Role','CreatedAt','PasswordHash','Salt','Sex','DateOfBirth','SchoolName','State','Nationality','HearAboutUs'],
    Papers:    ['PaperID','Title','Cadre','TotalQuestions','Duration','Active','CreatedAt'],
    Questions: ['QuestionID','PaperID','QuestionText','OptionA','OptionB','OptionC','OptionD','CorrectAnswer','RandomKey'],
    Attempts:  ['AttemptID','Email','PaperID','Score','StartTime','EndTime','AttemptNumber','Status'],
    Responses: ['AttemptID','QuestionID','SelectedAnswer','IsCorrect'],
    Autosaves: ['AttemptID','Email','SavedAt','AnswersJSON'],
    Config:    ['Key','Value']
  };

  Object.keys(schemas).forEach(function (name) {
    var headers = schemas[name];
    var sh      = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.appendRow(headers);
      sh.getRange(1, 1, 1, headers.length)
        .setBackground('#1a73e8').setFontColor('#fff').setFontWeight('bold');
      sh.setFrozenRows(1);
      log.push('CREATED: ' + name);
    } else {
      log.push('EXISTS:  ' + name);
    }
  });

  var cfg = ss.getSheetByName(SHEET.CONFIG);
  if (cfg.getLastRow() < 2) {
    cfg.appendRow(['ExamDurationMinutes', '60']);
    cfg.appendRow(['AllowRetakes',        'TRUE']);
    cfg.appendRow(['MaxRetakes',          '999']);
    log.push('SEEDED: Config defaults');
  }

  var users = ss.getSheetByName(SHEET.USERS);
  if (users.getLastRow() < 2) {
    users.appendRow(['admin@cbt.ng', 'Admin User', 'CHEW', 'admin',
                     new Date().toISOString(), '', '']);
    log.push('SEEDED: admin@cbt.ng');
  }

  Logger.log(log.join('\n'));
  _alert('✅ CHeNatEPrep Ready',
    'All sheets initialised.\nAdmin: admin@cbt.ng\n\n' +
    'After any code change: Deploy > Manage Deployments >\n' +
    'Edit > New Version > Deploy.\nSee View > Logs for details.');
}
