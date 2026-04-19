// ============================================================
//  CHNatPrep CBT Platform
//  Developed by DSD (Data Solution Drivers)
//  Admin.gs — Paper management, questions, statistics
//
//  togglePaper: sets Active column (TRUE/FALSE) via updateRow.
//  importQuestions: uses batchInsert — one write for N rows.
//  getStats: loads all sheets once, joins in JS.
// ============================================================

var Admin = (function () {

  var VALID_CADRES = ['JCHEW', 'CHEW', 'CHO'];

  // ── Papers ───────────────────────────────────────────────

  function addPaper(data) {
    try {
      var title = data ? String(data.title || '').trim() : '';
      var cadre = data ? String(data.cadre || '').trim() : '';
      var total = data ? (Number(data.totalQuestions) || 100) : 100;
      var dur   = data ? (Number(data.duration)       || 60)  : 60;

      if (!title || !cadre) return { ok: false, error: 'Title and cadre are required.' };
      if (VALID_CADRES.indexOf(cadre) < 0)
        return { ok: false, error: 'Invalid cadre. Must be JCHEW, CHEW or CHO.' };

      var paperID = DB.newId('PAP');
      DB.insert(SHEET.PAPERS, {
        PaperID: paperID, Title: title, Cadre: cadre,
        TotalQuestions: total, Duration: dur,
        Active: 'TRUE', CreatedAt: new Date().toISOString()
      });
      return { ok: true, paperID: paperID };
    } catch (e) {
      Logger.log('[addPaper] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  // Sets Active = 'TRUE' or 'FALSE'; returns the new state.
  function togglePaper(data) {
    try {
      var paperID = data ? String(data.paperID || '') : '';
      if (!paperID) return { ok: false, error: 'paperID required.' };

      var paper = DB.findOne(SHEET.PAPERS, function (p) {
        return String(p.PaperID) === paperID;
      });
      if (!paper) return { ok: false, error: 'Paper not found.' };

      // Explicit value wins; otherwise toggle current state
      var newActive;
      if (data.active !== null && data.active !== undefined) {
        newActive = data.active === true || String(data.active).toUpperCase() === 'TRUE';
      } else {
        newActive = String(paper.Active).toUpperCase() === 'FALSE'; // flip
      }

      DB.updateRow(SHEET.PAPERS, 'PaperID', paperID, {
        Active: newActive ? 'TRUE' : 'FALSE'
      });
      return { ok: true, paperID: paperID, active: newActive };
    } catch (e) {
      Logger.log('[togglePaper] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  function deletePaper(data) {
    try {
      var paperID = data ? String(data.paperID || '') : '';
      var n = DB.deleteRows(SHEET.PAPERS,    function (p) { return String(p.PaperID) === paperID; });
      DB.deleteRows(SHEET.QUESTIONS, function (q) { return String(q.PaperID) === paperID; });
      return { ok: true, deleted: n };
    } catch (e) {
      Logger.log('[deletePaper] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  // ── Questions ────────────────────────────────────────────

  function addQuestion(data) {
    try {
      var paperID  = data ? String(data.paperID      || '') : '';
      var text     = data ? String(data.questionText || '').trim() : '';
      var optA     = data ? String(data.optionA      || '').trim() : '';
      var optB     = data ? String(data.optionB      || '').trim() : '';
      var optC     = data ? String(data.optionC      || '').trim() : '';
      var optD     = data ? String(data.optionD      || '').trim() : '';
      var ans      = data ? String(data.correctAnswer|| '').toUpperCase().trim() : '';

      if (!paperID || !text || !optA || !optB || !ans)
        return { ok: false, error: 'PaperID, question, options A & B, and answer are required.' };
      if (['A','B','C','D'].indexOf(ans) < 0)
        return { ok: false, error: 'CorrectAnswer must be A, B, C or D.' };
      if (!DB.findOne(SHEET.PAPERS, function (p) { return String(p.PaperID) === paperID; }))
        return { ok: false, error: 'Paper not found.' };

      var qID = DB.newId('QST');
      DB.insert(SHEET.QUESTIONS, {
        QuestionID: qID, PaperID: paperID, QuestionText: text,
        OptionA: optA, OptionB: optB, OptionC: optC, OptionD: optD,
        CorrectAnswer: ans, RandomKey: Math.random()
      });
      return { ok: true, questionID: qID };
    } catch (e) {
      Logger.log('[addQuestion] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  // Bulk import — one batchInsert call for all valid rows
  function importQuestions(data) {
    try {
      var paperID   = data ? String(data.paperID || '') : '';
      var questions = data ? data.questions : null;
      if (!paperID || !Array.isArray(questions) || !questions.length)
        return { ok: false, error: 'PaperID and a non-empty questions array are required.' };
      if (!DB.findOne(SHEET.PAPERS, function (p) { return String(p.PaperID) === paperID; }))
        return { ok: false, error: 'Paper not found.' };

      var rows   = [];
      var errors = [];
      questions.forEach(function (q, idx) {
        var ans = String(q.correctAnswer || '').toUpperCase().trim();
        if (!q.questionText || !q.optionA || !q.optionB || ['A','B','C','D'].indexOf(ans) < 0) {
          errors.push('Q' + (idx + 1) + ': missing required fields or invalid answer.');
          return;
        }
        rows.push({
          QuestionID: DB.newId('QST'), PaperID: paperID,
          QuestionText: String(q.questionText).trim(),
          OptionA: String(q.optionA || '').trim(),
          OptionB: String(q.optionB || '').trim(),
          OptionC: String(q.optionC || '').trim(),
          OptionD: String(q.optionD || '').trim(),
          CorrectAnswer: ans, RandomKey: Math.random()
        });
      });

      if (rows.length) DB.batchInsert(SHEET.QUESTIONS, rows);
      return { ok: true, inserted: rows.length, errors: errors };
    } catch (e) {
      Logger.log('[importQuestions] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  function deleteQuestion(data) {
    try {
      var qID = data ? String(data.questionID || '') : '';
      var n   = DB.deleteRows(SHEET.QUESTIONS, function (q) {
        return String(q.QuestionID) === qID;
      });
      return { ok: true, deleted: n };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  function getQuestions(data) {
    try {
      var paperID = data ? String(data.paperID || '') : '';
      var qs = paperID
        ? DB.find(SHEET.QUESTIONS, function (q) { return String(q.PaperID) === paperID; })
        : DB.getAll(SHEET.QUESTIONS);
      return { ok: true, questions: qs };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ── Stats ────────────────────────────────────────────────
  // Loads all sheets once; all aggregation done in JS.
  function getStats() {
    try {
      var users     = DB.getAll(SHEET.USERS);
      var papers    = DB.getAll(SHEET.PAPERS);
      var questions = DB.getAll(SHEET.QUESTIONS);
      var attempts  = DB.getAll(SHEET.ATTEMPTS).filter(function (a) {
        return a.Status === 'submitted';
      });

      // Per-cadre student counts
      var byCadre = { JCHEW: 0, CHEW: 0, CHO: 0 };
      var students = 0;
      users.forEach(function (u) {
        if (u.Role !== 'student') return;
        students++;
        if (byCadre[u.Cadre] !== undefined) byCadre[u.Cadre]++;
      });

      // Question count per paper
      var qMap = {};
      questions.forEach(function (q) {
        var k = String(q.PaperID); qMap[k] = (qMap[k] || 0) + 1;
      });

      // Attempt stats per paper
      var paperStats = papers.map(function (p) {
        var pid   = String(p.PaperID);
        var pAtts = attempts.filter(function (a) { return String(a.PaperID) === pid; });
        var scores = pAtts.map(function (a) { return Number(a.Score) || 0; });
        var sum    = scores.reduce(function (t, v) { return t + v; }, 0);
        return {
          paperID:   pid,
          title:     String(p.Title),
          cadre:     String(p.Cadre),
          active:    String(p.Active).toUpperCase() !== 'FALSE',
          questions: qMap[pid] || 0,
          attempts:  pAtts.length,
          avgScore:  pAtts.length ? Math.round(sum / pAtts.length) : 0
        };
      });

      var allScores = attempts.map(function (a) { return Number(a.Score) || 0; });
      var scoreSum  = allScores.reduce(function (t, v) { return t + v; }, 0);

      return {
        ok: true,
        stats: {
          totalStudents:  students,
          jchewStudents:  byCadre.JCHEW,
          chewStudents:   byCadre.CHEW,
          choStudents:    byCadre.CHO,
          totalPapers:    papers.length,
          totalQuestions: questions.length,
          totalAttempts:  attempts.length,
          avgScore:       attempts.length ? Math.round(scoreSum / attempts.length) : 0,
          paperStats:     paperStats
        }
      };
    } catch (e) {
      Logger.log('[getStats] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  function getAllUsers()    { try { return { ok: true, users:    DB.getAll(SHEET.USERS) };    } catch (e) { return { ok: false, error: e.message }; } }
  function getAllAttempts() { try { return { ok: true, attempts: DB.getAll(SHEET.ATTEMPTS) }; } catch (e) { return { ok: false, error: e.message }; } }

  return {
    addPaper, togglePaper, deletePaper,
    addQuestion, importQuestions, deleteQuestion, getQuestions,
    getStats, getAllUsers, getAllAttempts
  };
})();
