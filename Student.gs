// ============================================================
//  CHNatPrep CBT Platform
//  Developed by DSD (Data Solution Drivers)
//  Student.gs — Attempt history, result review, analytics
//
//  All three functions load sheets once and join in JS.
//  Option keys are returned as optionA/B/C/D (lowercase prefix)
//  to match the frontend review renderer's q['option'+k] lookup.
// ============================================================

var Student = (function () {

  // ── Helpers ──────────────────────────────────────────────

  function _email(data) {
    return data && data.email ? String(data.email).toLowerCase() : '';
  }

  function _paperMap(papers) {
    var m = {};
    papers.forEach(function (p) { m[String(p.PaperID)] = p; });
    return m;
  }

  function _score(attempt, paper) {
    var total   = parseInt((paper || {}).TotalQuestions || 100, 10);
    var score   = Number(attempt.Score) || 0;
    var percent = total > 0 ? Math.round((score / total) * 100) : 0;
    return { score: score, total: total, percent: percent, passed: percent >= 50 };
  }

  // ── getMyAttempts ────────────────────────────────────────
  // Returns all submitted attempts for a student, enriched with
  // paper metadata. Exposes PaperID for the history modal filter.
  function getMyAttempts(data) {
    try {
      var email = _email(data);
      if (!email) return { ok: false, error: 'Email required.' };

      var pm       = _paperMap(DB.getAll(SHEET.PAPERS));
      var enriched = DB.getAll(SHEET.ATTEMPTS)
        .filter(function (a) {
          return String(a.Email).toLowerCase() === email && a.Status === 'submitted';
        })
        .map(function (a) {
          var paper = pm[String(a.PaperID)] || {};
          var s     = _score(a, paper);
          return {
            attemptID:     String(a.AttemptID),
            PaperID:       String(a.PaperID),
            paperTitle:    String(paper.Title  || a.PaperID),
            cadre:         String(paper.Cadre  || ''),
            score:         s.score,
            total:         s.total,
            percent:       s.percent,
            passed:        s.passed,
            startTime:     String(a.StartTime  || ''),
            endTime:       String(a.EndTime    || ''),
            attemptNumber: Number(a.AttemptNumber) || 1
          };
        })
        .sort(function (x, y) { return new Date(y.startTime) - new Date(x.startTime); });

      return { ok: true, attempts: enriched };
    } catch (e) {
      Logger.log('[getMyAttempts] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  // ── getAttemptResult ─────────────────────────────────────
  // Returns the full attempt result with per-question review.
  function getAttemptResult(data) {
    try {
      var attemptID = data && data.attemptID ? String(data.attemptID) : '';
      var email     = _email(data);
      if (!attemptID || !email) return { ok: false, error: 'attemptID and email required.' };

      var attempt = DB.findOne(SHEET.ATTEMPTS, function (a) {
        return String(a.AttemptID) === attemptID;
      });
      if (!attempt) return { ok: false, error: 'Attempt not found.' };
      if (String(attempt.Email).toLowerCase() !== email)
        return { ok: false, error: 'Unauthorised.' };

      var paper = DB.findOne(SHEET.PAPERS, function (p) {
        return String(p.PaperID) === String(attempt.PaperID);
      }) || {};

      // Build question map for O(1) lookup during response mapping
      var qMap = {};
      DB.find(SHEET.QUESTIONS, function (q) {
        return String(q.PaperID) === String(attempt.PaperID);
      }).forEach(function (q) { qMap[String(q.QuestionID)] = q; });

      var detailed = DB.find(SHEET.RESPONSES, function (r) {
        return String(r.AttemptID) === attemptID;
      }).map(function (r) {
        var q         = qMap[String(r.QuestionID)] || {};
        var isCorrect = r.IsCorrect === true || String(r.IsCorrect).toUpperCase() === 'TRUE';
        return {
          questionText: String(q.QuestionText    || ''),
          optionA:      String(q.OptionA         || ''),  // lowercase key for frontend
          optionB:      String(q.OptionB         || ''),
          optionC:      String(q.OptionC         || ''),
          optionD:      String(q.OptionD         || ''),
          selected:     String(r.SelectedAnswer  || ''),
          correct:      String(q.CorrectAnswer   || ''),
          isCorrect:    isCorrect
        };
      });

      var total   = detailed.length;
      var score   = Number(attempt.Score) || 0;
      var percent = total > 0 ? Math.round((score / total) * 100) : 0;

      return {
        ok: true,
        result: {
          attemptID:     attemptID,
          paperTitle:    String(paper.Title || ''),
          cadre:         String(paper.Cadre || ''),
          score:         score,
          total:         total,
          percent:       percent,
          passed:        percent >= 50,
          startTime:     String(attempt.StartTime    || ''),
          endTime:       String(attempt.EndTime      || ''),
          attemptNumber: Number(attempt.AttemptNumber) || 1,
          detailed:      detailed
        }
      };
    } catch (e) {
      Logger.log('[getAttemptResult] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  // ── getAnalytics ──────────────────────────────────────────
  function getAnalytics(data) {
    try {
      var email = _email(data);
      if (!email) return { ok: false, error: 'Email required.' };

      var pm       = _paperMap(DB.getAll(SHEET.PAPERS));
      var attempts = DB.getAll(SHEET.ATTEMPTS).filter(function (a) {
        return String(a.Email).toLowerCase() === email && a.Status === 'submitted';
      });

      if (!attempts.length) {
        return { ok: true, analytics: { totalAttempts: 0, avgPercent: 0,
          bestPercent: 0, passRate: 0, papers: [] } };
      }

      // Group by paper
      var byPaper = {};
      var allPcts = [];
      attempts.forEach(function (a) {
        var paper   = pm[String(a.PaperID)] || {};
        var s       = _score(a, paper);
        var key     = String(a.PaperID);
        allPcts.push(s.percent);
        if (!byPaper[key]) {
          byPaper[key] = { paperID: key, title: String(paper.Title || key),
                           cadre: String(paper.Cadre || ''), attempts: [] };
        }
        byPaper[key].attempts.push({
          attemptNumber: Number(a.AttemptNumber) || 1,
          score: s.score, total: s.total, percent: s.percent,
          date: String(a.StartTime || '')
        });
      });

      // Summarise per paper
      var papers = Object.keys(byPaper).map(function (k) {
        var p    = byPaper[k];
        var pcts = p.attempts.map(function (a) { return a.percent; });
        var sum  = pcts.reduce(function (t, v) { return t + v; }, 0);
        return {
          paperID:  p.paperID,
          title:    p.title,
          cadre:    p.cadre,
          attempts: p.attempts,
          best:     Math.max.apply(null, pcts),
          avg:      Math.round(sum / pcts.length),
          trend:    pcts.length > 1 ? pcts[pcts.length - 1] - pcts[0] : 0
        };
      });

      var totalSum  = allPcts.reduce(function (t, v) { return t + v; }, 0);
      var passed    = allPcts.filter(function (p) { return p >= 50; }).length;

      return {
        ok: true,
        analytics: {
          totalAttempts: attempts.length,
          avgPercent:    Math.round(totalSum / allPcts.length),
          bestPercent:   Math.max.apply(null, allPcts),
          passedCount:   passed,
          passRate:      Math.round((passed / attempts.length) * 100),
          papers:        papers
        }
      };
    } catch (e) {
      Logger.log('[getAnalytics] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  return { getMyAttempts, getAttemptResult, getAnalytics };
})();
