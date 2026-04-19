// ============================================================
//  CHNatPrep CBT Platform
//  Developed by DSD (Data Solution Drivers)
//  Exam.gs — Exam session management
//
//  Key design decisions:
//  · startExam:   Loads all needed sheets in one pass each,
//    re-uses an existing active attempt on refresh.
//  · resumeExam:  Returns server-authoritative remaining time
//    and saved answers for cross-device session restore.
//  · autosaveExam: Upserts one row in Autosaves — never grows.
//  · submitExam:  4 total API calls for any question count via
//    batchInsert (all responses in one setValues call).
//  · checkPaperActive: Lightweight single-row lookup polled
//    every 60 s to enforce real-time deactivation.
// ============================================================

var Exam = (function () {

  var GRACE_MS = 30 * 1000; // 30-second grace buffer for auto-submit

  // ── Helpers ──────────────────────────────────────────────

  function _isActive(paper) {
    return String(paper.Active || '').toUpperCase() !== 'FALSE';
  }

  function _shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function _stripQuestion(q) {
    return {
      QuestionID:   String(q.QuestionID),
      QuestionText: String(q.QuestionText),
      OptionA:      String(q.OptionA || ''),
      OptionB:      String(q.OptionB || ''),
      OptionC:      String(q.OptionC || ''),
      OptionD:      String(q.OptionD || '')
      // CorrectAnswer intentionally excluded from client payload
    };
  }

  function _attemptMeta(attempt, paper) {
    var endMs = new Date(attempt.EndTime).getTime();
    return {
      attemptID:     String(attempt.AttemptID),
      paperID:       String(attempt.PaperID),
      paperTitle:    String(paper.Title),
      cadre:         String(paper.Cadre),
      startTime:     String(attempt.StartTime),
      endTime:       String(attempt.EndTime),
      attemptNumber: Number(attempt.AttemptNumber) || 1,
      remainingSecs: Math.max(0, Math.floor((endMs - Date.now()) / 1000))
    };
  }

  // ── getPapers ─────────────────────────────────────────────
  function getPapers(data) {
    try {
      var cadre     = data ? data.cadre : null;
      var papers    = DB.getAll(SHEET.PAPERS);
      var questions = DB.getAll(SHEET.QUESTIONS);

      // Build question-count map in JS (no extra sheet reads)
      var qCount = {};
      questions.forEach(function (q) {
        var pid = String(q.PaperID);
        qCount[pid] = (qCount[pid] || 0) + 1;
      });

      var result = papers
        .filter(function (p) { return !cadre || String(p.Cadre) === cadre; })
        .map(function (p) {
          return {
            PaperID:        String(p.PaperID),
            Title:          String(p.Title),
            Cadre:          String(p.Cadre),
            TotalQuestions: Number(p.TotalQuestions) || 100,
            Duration:       Number(p.Duration) || 60,
            Active:         _isActive(p),
            questionCount:  qCount[String(p.PaperID)] || 0
          };
        });

      return { ok: true, papers: result };
    } catch (e) {
      Logger.log('[getPapers] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  // ── resumeExam ────────────────────────────────────────────
  // Recovers an in-progress session from the server. Works
  // across devices because it reads Google Sheets, not cookies.
  function resumeExam(data) {
    try {
      var email = data ? String(data.email || '').toLowerCase() : '';
      if (!email) return { ok: false, error: 'Email required.' };

      // Find the most recent active attempt that hasn't expired
      var active = null;
      var latest = 0;
      DB.getAll(SHEET.ATTEMPTS).forEach(function (a) {
        if (String(a.Email).toLowerCase() !== email) return;
        if (a.Status !== 'active') return;
        var end = new Date(a.EndTime).getTime();
        if (Date.now() > end + GRACE_MS) return;
        var start = new Date(a.StartTime).getTime();
        if (start > latest) { latest = start; active = a; }
      });

      if (!active) return { ok: false, reason: 'no_active_attempt' };

      var paper = DB.findOne(SHEET.PAPERS, function (p) {
        return String(p.PaperID) === String(active.PaperID);
      });
      if (!paper)          return { ok: false, error: 'Paper not found.' };
      if (!_isActive(paper)) return { ok: false, reason: 'paper_inactive',
        error: 'This exam has been deactivated by the administrator.' };

      // Recover saved answers (may be empty on first session)
      var savedAnswers = {};
      var autosave = DB.findOne(SHEET.AUTOSAVES, function (r) {
        return String(r.AttemptID) === String(active.AttemptID);
      });
      if (autosave && autosave.AnswersJSON) {
        try { savedAnswers = JSON.parse(String(autosave.AnswersJSON)); } catch (e) {}
      }

      var questions = DB.find(SHEET.QUESTIONS, function (q) {
        return String(q.PaperID) === String(active.PaperID);
      }).map(_stripQuestion);

      return {
        ok:          true,
        attempt:     _attemptMeta(active, paper),
        questions:   questions,
        savedAnswers: savedAnswers
      };
    } catch (e) {
      Logger.log('[resumeExam] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  // ── autosaveExam ──────────────────────────────────────────
  // Upserts one row per attempt — no unbounded growth.
  function autosaveExam(data) {
    try {
      var attemptID   = data ? String(data.attemptID   || '') : '';
      var email       = data ? String(data.email       || '').toLowerCase() : '';
      var answersJSON = data ? String(data.answersJSON || '{}') : '{}';
      if (!attemptID || !email) return { ok: false, error: 'attemptID and email required.' };

      var attempt = DB.findOne(SHEET.ATTEMPTS, function (a) {
        return String(a.AttemptID) === attemptID;
      });
      if (!attempt || attempt.Status === 'submitted')
        return { ok: false, reason: 'already_submitted' };

      var now     = new Date().toISOString();
      var updated = DB.updateRow(SHEET.AUTOSAVES, 'AttemptID', attemptID, {
        SavedAt: now, AnswersJSON: answersJSON
      });
      if (updated === 0) {
        DB.insert(SHEET.AUTOSAVES, {
          AttemptID: attemptID, Email: email, SavedAt: now, AnswersJSON: answersJSON
        });
      }
      return { ok: true, savedAt: now };
    } catch (e) {
      Logger.log('[autosaveExam] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  // ── startExam ─────────────────────────────────────────────
  // Loads all sheets in parallel (one getAll each), joins in JS.
  function startExam(data) {
    try {
      var email   = data ? String(data.email   || '').trim().toLowerCase() : '';
      var paperID = data ? String(data.paperID || '').trim() : '';
      if (!email || !paperID) return { ok: false, error: 'Email and PaperID are required.' };

      // Load all needed data — one read per sheet
      var allUsers     = DB.getAll(SHEET.USERS);
      var allPapers    = DB.getAll(SHEET.PAPERS);
      var allAttempts  = DB.getAll(SHEET.ATTEMPTS);
      var allQuestions = DB.getAll(SHEET.QUESTIONS);
      var allConfig    = DB.getAll(SHEET.CONFIG);

      // Build config map
      var cfg = {};
      allConfig.forEach(function (r) { cfg[r.Key] = r.Value; });

      // Validate user
      var user = allUsers.filter(function (u) {
        return String(u.Email).toLowerCase() === email;
      })[0];
      if (!user) return { ok: false, error: 'User not found.' };

      // Validate paper
      var paper = allPapers.filter(function (p) {
        return String(p.PaperID) === paperID;
      })[0];
      if (!paper) return { ok: false, error: 'Paper not found.' };
      if (!_isActive(paper))
        return { ok: false, error: 'This exam is currently unavailable.' };

      // Re-use an existing active attempt (handles refresh without duplicating)
      var existing = allAttempts.filter(function (a) {
        return String(a.Email).toLowerCase() === email &&
               String(a.PaperID) === paperID &&
               a.Status === 'active' &&
               Date.now() <= new Date(a.EndTime).getTime() + GRACE_MS;
      })[0];
      if (existing) return _buildResponse(existing, paper, allQuestions, true);

      // Retake policy
      var rawAllow     = cfg['AllowRetakes'];
      var allowRetakes = rawAllow === true || String(rawAllow).toUpperCase() === 'TRUE';
      var maxRetakes   = parseInt(cfg['MaxRetakes'] || '999', 10);
      if (isNaN(maxRetakes) || maxRetakes < 0) maxRetakes = 999;

      var submitted = allAttempts.filter(function (a) {
        return String(a.Email).toLowerCase() === email &&
               String(a.PaperID) === paperID &&
               a.Status === 'submitted';
      });
      if (!allowRetakes && submitted.length > 0)
        return { ok: false, error: 'Retakes are not allowed for this exam.' };
      if (submitted.length >= maxRetakes)
        return { ok: false, error: 'Maximum retakes (' + maxRetakes + ') reached.' };

      // Validate questions exist
      var paperQs = allQuestions.filter(function (q) {
        return String(q.PaperID) === paperID;
      });
      if (!paperQs.length)
        return { ok: false, error: 'No questions available for this paper yet.' };

      // Create attempt record
      var dur       = parseInt(paper.Duration || cfg['ExamDurationMinutes'] || '60', 10);
      if (isNaN(dur) || dur <= 0) dur = 60;
      var now       = new Date();
      var endTime   = new Date(now.getTime() + dur * 60000);
      var attemptID = DB.newId('ATT');

      DB.insert(SHEET.ATTEMPTS, {
        AttemptID:     attemptID,
        Email:         email,
        PaperID:       paperID,
        Score:         '',
        StartTime:     now.toISOString(),
        EndTime:       endTime.toISOString(),
        AttemptNumber: submitted.length + 1,
        Status:        'active'
      });

      return _buildResponse(
        { AttemptID: attemptID, PaperID: paperID, Email: email,
          StartTime: now.toISOString(), EndTime: endTime.toISOString(),
          AttemptNumber: submitted.length + 1, Status: 'active' },
        paper, allQuestions, false
      );
    } catch (e) {
      Logger.log('[startExam] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  function _buildResponse(attempt, paper, allQuestions, resumed) {
    var qs = allQuestions
      .filter(function (q) { return String(q.PaperID) === String(attempt.PaperID); });
    return {
      ok:       true,
      resumed:  resumed,
      attempt:  _attemptMeta(attempt, paper),
      questions: (resumed ? qs : _shuffle(qs)).map(_stripQuestion)
    };
  }

  // ── submitExam ────────────────────────────────────────────
  // Total Sheets API calls: 2 reads + 1 batchInsert + 1 updateRow = 4.
  function submitExam(data) {
    try {
      var attemptID = data ? String(data.attemptID || '') : '';
      var email     = data ? String(data.email     || '').toLowerCase() : '';
      var responses = data ? data.responses : null;
      if (!attemptID || !email || !Array.isArray(responses))
        return { ok: false, error: 'Invalid submission payload.' };

      var attempt = DB.findOne(SHEET.ATTEMPTS, function (a) {
        return String(a.AttemptID) === attemptID;
      });
      if (!attempt)                       return { ok: false, error: 'Attempt not found.' };
      if (attempt.Status === 'submitted') return { ok: false, error: 'Already submitted.' };
      if (String(attempt.Email).toLowerCase() !== email)
        return { ok: false, error: 'Unauthorised.' };

      var now = new Date();
      if (now.getTime() > new Date(attempt.EndTime).getTime() + GRACE_MS)
        return { ok: false, error: 'Submission window has closed.' };

      // Build answer key — one sheet read
      var answerKey = {};
      var total     = 0;
      DB.getAll(SHEET.QUESTIONS).forEach(function (q) {
        if (String(q.PaperID) === String(attempt.PaperID)) {
          answerKey[String(q.QuestionID)] = String(q.CorrectAnswer);
          total++;
        }
      });

      // Score in JS; build response rows for batch write
      var score = 0;
      var rows  = responses.map(function (r) {
        var selected  = r.selected ? String(r.selected) : '';
        var correct   = answerKey[String(r.questionID || '')] || '';
        var isCorrect = !!(correct && selected === correct);
        if (isCorrect) score++;
        return { AttemptID: attemptID, QuestionID: String(r.questionID || ''),
                 SelectedAnswer: selected, IsCorrect: isCorrect };
      });

      DB.batchInsert(SHEET.RESPONSES, rows);           // 1 API call for all rows
      DB.updateRow(SHEET.ATTEMPTS, 'AttemptID', attemptID, {
        Score: score, Status: 'submitted', EndTime: now.toISOString()
      });

      try { DB.deleteRows(SHEET.AUTOSAVES, function (r) {
        return String(r.AttemptID) === attemptID;
      }); } catch (e) {}

      var percent = total > 0 ? Math.round((score / total) * 100) : 0;
      return {
        ok: true,
        result: {
          attemptID:     attemptID,
          score:         score,
          total:         total,
          percent:       percent,
          passed:        percent >= 50,
          attemptNumber: Number(attempt.AttemptNumber) || 1
        }
      };
    } catch (e) {
      Logger.log('[submitExam] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  // ── checkPaperActive ──────────────────────────────────────
  // Polled every 60 s during an active exam to enforce
  // real-time admin deactivation without page reload.
  function checkPaperActive(data) {
    try {
      var paperID = data ? String(data.paperID || '') : '';
      if (!paperID) return { ok: false, error: 'paperID required.' };
      var paper = DB.findOne(SHEET.PAPERS, function (p) {
        return String(p.PaperID) === paperID;
      });
      if (!paper) return { ok: false, error: 'Paper not found.' };
      return { ok: true, active: _isActive(paper) };
    } catch (e) {
      Logger.log('[checkPaperActive] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  return { getPapers, resumeExam, autosaveExam, startExam, submitExam, checkPaperActive };
})();
