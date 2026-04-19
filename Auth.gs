// ============================================================
//  CHeNatEPrep Platform
//  Developed by DSD (Data Solution Drivers)
//  Auth.gs — Authentication, registration, password management,
//             password recovery, and contact/support routing.
//
//  Security:  SHA-256 + per-user salt for all passwords.
//  Schema:    Users sheet columns (in order):
//             Email | FullName | Cadre | Role | CreatedAt |
//             PasswordHash | Salt | Sex | DateOfBirth |
//             SchoolName | State | Nationality | HearAboutUs
//  Backward-compat: existing rows without biodata columns
//             are read and written without disruption.
// ============================================================

var Auth = (function () {

  var VALID_CADRES = ['JCHEW', 'CHEW', 'CHO'];

  // Support inbox — never exposed to the client side
  var _SUPPORT_EMAIL = 'datasolutiondrivers@gmail.com';

  // ── Crypto ───────────────────────────────────────────────

  function _sha256(password, salt) {
    var bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      salt + ':' + password,
      Utilities.Charset.UTF_8
    );
    return bytes.map(function (b) {
      var h = ((b + 256) % 256).toString(16);
      return h.length < 2 ? '0' + h : h;
    }).join('');
  }

  function _salt() {
    var c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var s = '';
    for (var i = 0; i < 16; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
  }

  // 10-char temp password mixing upper, lower, digits, symbols
  function _tempPw() {
    var c = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
    var p = '';
    for (var i = 0; i < 10; i++) p += c[Math.floor(Math.random() * c.length)];
    return p;
  }

  // ── Sheet helpers (one read per public call) ─────────────

  function _load() {
    var s    = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.USERS);
    var data = s.getDataRange().getValues();
    return { s: s, headers: data[0] || [], rows: data.slice(1) };
  }

  // Returns a full user object from pre-loaded data, or null.
  function _find(ld, email) {
    var norm = String(email).toLowerCase();
    for (var i = 0; i < ld.rows.length; i++) {
      if (String(ld.rows[i][0]).toLowerCase() !== norm) continue;
      var col = function (name) {
        var idx = ld.headers.indexOf(name);
        return idx !== -1 ? String(ld.rows[i][idx] || '') : '';
      };
      return {
        rowIndex:     i + 2,
        email:        col('Email'),
        fullName:     col('FullName'),
        cadre:        col('Cadre'),
        role:         col('Role'),
        passwordHash: col('PasswordHash'),
        salt:         col('Salt'),
        ld:           ld
      };
    }
    return null;
  }

  // Public-safe user object — never includes hash, salt, or biodata
  function _pub(u) {
    return { email: u.email, fullName: u.fullName, cadre: u.cadre, role: u.role };
  }

  // Writes a new hash+salt pair using two targeted cell writes.
  // Does NOT rewrite the whole row — other columns are untouched.
  function _writePassword(u, password) {
    var s       = u.ld.s;
    var hdrs    = u.ld.headers;
    var hi      = hdrs.indexOf('PasswordHash');
    var si      = hdrs.indexOf('Salt');
    var newSalt = _salt();
    var newHash = _sha256(password, newSalt);
    if (hi === -1) {
      // Columns missing (legacy sheet) — append them to the header row
      s.getRange(1, hdrs.length + 1).setValue('PasswordHash');
      s.getRange(1, hdrs.length + 2).setValue('Salt');
      hi = hdrs.length;
      si = hdrs.length + 1;
    }
    s.getRange(u.rowIndex, hi + 1).setValue(newHash);
    s.getRange(u.rowIndex, si + 1).setValue(newSalt);
    return { ok: true, user: _pub(u), passwordSet: true };
  }

  // ── Public API ────────────────────────────────────────────

  function getCurrentUser() {
    try {
      var email = Session.getActiveUser().getEmail();
      if (!email) return { ok: false, error: 'Not authenticated.' };
      var ld = _load();
      var u  = _find(ld, email);
      if (!u) return { ok: false, error: 'User not registered.', email: email };
      return { ok: true, user: _pub(u), hasPassword: !!u.passwordHash };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  function login(data) {
    try {
      if (!data) return { ok: false, error: 'Invalid request.' };
      var email    = String(data.email    || '').trim().toLowerCase();
      var password = String(data.password || '').trim();
      if (!email) return { ok: false, error: 'Email is required.' };

      var ld = _load();
      var u  = _find(ld, email);
      if (!u) return { ok: false, error: 'No account found. Please register.' };

      if (u.passwordHash && u.salt) {
        if (!password)
          return { ok: false, error: 'Password is required.', needsPassword: true };
        if (_sha256(password, u.salt) !== u.passwordHash)
          return { ok: false, error: 'Incorrect password.' };
      } else {
        // No password set yet — first login sets it on the fly
        if (password) return _writePassword(u, password);
        return { ok: true, user: _pub(u), needsPassword: true };
      }
      return { ok: true, user: _pub(u) };
    } catch (e) {
      Logger.log('[login] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  // ── register ──────────────────────────────────────────────
  // Extended with five biodata fields. Appends one row whose
  // column order matches the Users schema in Code.gs.
  // Existing rows are never touched.
  function register(data) {
    try {
      if (!data) return { ok: false, error: 'Invalid request.' };

      // Core identity
      var email    = String(data.email    || '').trim().toLowerCase();
      var fullName = String(data.fullName || '').trim();
      var cadre    = String(data.cadre    || '').trim();
      var password = String(data.password || '').trim();

      // Biodata
      var sex          = String(data.sex          || '').trim();
      var dob          = String(data.dob          || '').trim();  // YYYY-MM-DD
      var schoolName   = String(data.schoolName   || '').trim();
      var state        = String(data.state        || '').trim();
      var nationality  = String(data.nationality  || '').trim();
      var hearAboutUs  = String(data.hearAboutUs  || '').trim();  // optional

      // ── Validation ──────────────────────────────────────
      if (!email || !fullName || !cadre)
        return { ok: false, error: 'Full name, email, and cadre are required.' };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return { ok: false, error: 'Enter a valid email address.' };
      if (password.length < 6)
        return { ok: false, error: 'Password must be at least 6 characters.' };
      if (VALID_CADRES.indexOf(cadre) < 0)
        return { ok: false, error: 'Invalid cadre. Must be JCHEW, CHEW or CHO.' };
      if (sex !== 'Male' && sex !== 'Female')
        return { ok: false, error: 'Please select your sex (Male or Female).' };
      if (!dob || isNaN(new Date(dob).getTime()))
        return { ok: false, error: 'Enter a valid date of birth.' };
      if (!schoolName)
        return { ok: false, error: 'School name is required.' };
      if (!state)
        return { ok: false, error: 'State is required.' };
      if (!nationality)
        return { ok: false, error: 'Nationality is required.' };

      var ld = _load();
      if (_find(ld, email))
        return { ok: false, error: 'An account with this email already exists.' };

      var s = _salt();
      var h = _sha256(password, s);

      // Column order must match the schema in Code.gs initializeSpreadsheet:
      // Email | FullName | Cadre | Role | CreatedAt | PasswordHash | Salt |
      // Sex | DateOfBirth | SchoolName | State | Nationality | HearAboutUs
      ld.s.appendRow([
        email, fullName, cadre, 'student', new Date().toISOString(), h, s,
        sex, dob, schoolName, state, nationality, hearAboutUs
      ]);

      return { ok: true, user: { email: email, fullName: fullName, cadre: cadre, role: 'student' } };
    } catch (e) {
      Logger.log('[register] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  function setPassword(data) {
    try {
      var email = String((data || {}).email    || '').trim().toLowerCase();
      var pw    = String((data || {}).password || '').trim();
      if (!email || pw.length < 6)
        return { ok: false, error: 'Email and password (min 6 chars) required.' };
      var ld = _load();
      var u  = _find(ld, email);
      if (!u) return { ok: false, error: 'User not found.' };
      return _writePassword(u, pw);
    } catch (e) { return { ok: false, error: e.message }; }
  }

  function changePassword(data) {
    try {
      var email = String((data || {}).email       || '').trim().toLowerCase();
      var oldPw = String((data || {}).oldPassword || '').trim();
      var newPw = String((data || {}).newPassword || '').trim();
      if (!email || !oldPw || newPw.length < 6)
        return { ok: false, error: 'All fields required; new password min 6 chars.' };
      var ld = _load();
      var u  = _find(ld, email);
      if (!u) return { ok: false, error: 'User not found.' };
      if (u.passwordHash && _sha256(oldPw, u.salt) !== u.passwordHash)
        return { ok: false, error: 'Current password is incorrect.' };
      return _writePassword(u, newPw);
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ── resetPassword ─────────────────────────────────────────
  // Generates a secure temp password, hashes it (plaintext is
  // never stored), then emails it to the user's registered address.
  // The user must change it immediately after logging in.
  function resetPassword(data) {
    try {
      var email = String((data || {}).email || '').trim().toLowerCase();
      if (!email) return { ok: false, error: 'Email is required.' };

      var ld = _load();
      var u  = _find(ld, email);
      if (!u) return { ok: false, error: 'No account found for this email address.' };

      var temp = _tempPw();
      _writePassword(u, temp);   // only the hash is stored

      try {
        MailApp.sendEmail({
          to:      email,
          subject: 'CHeNatEPrep \u2014 Your Temporary Password',
          body:
            'Hello ' + u.fullName + ',\n\n' +
            'You requested a password reset for your CHeNatEPrep account.\n\n' +
            'Your temporary password is:\n\n    ' + temp + '\n\n' +
            'Log in with this password, then set a new one immediately.\n' +
            'This temporary password will expire once you change it.\n\n' +
            'If you did not request this, contact support immediately.\n\n' +
            'Regards,\n' +
            'CHeNatEPrep Support Team\n' +
            'Powered by Data Solution Drivers (DSD)'
        });
      } catch (mailErr) {
        Logger.log('[resetPassword] MailApp error: ' + mailErr.message);
        return {
          ok: true, emailSent: false,
          message: 'Password reset, but email delivery failed. Contact your administrator.'
        };
      }

      return { ok: true, emailSent: true,
        message: 'A temporary password has been sent to ' + email + '.' };
    } catch (e) {
      Logger.log('[resetPassword] ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  // ── submitContact ─────────────────────────────────────────
  // Routes a support message to the hidden support inbox.
  // _SUPPORT_EMAIL is never sent to the client.
  function submitContact(data) {
    try {
      var name    = String((data || {}).name    || '').trim();
      var email   = String((data || {}).email   || '').trim();
      var subject = String((data || {}).subject || '').trim();
      var message = String((data || {}).message || '').trim();

      if (!name || !email || !message)
        return { ok: false, error: 'Name, email, and message are required.' };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return { ok: false, error: 'Enter a valid email address.' };
      if (message.length < 10)
        return { ok: false, error: 'Message too short. Please provide more detail.' };
      if (message.length > 2000)
        return { ok: false, error: 'Message must not exceed 2000 characters.' };

      MailApp.sendEmail({
        to:      _SUPPORT_EMAIL,
        replyTo: email,
        subject: '[CHeNatEPrep Support] ' + (subject || 'New enquiry') + ' \u2014 ' + name,
        body:
          'From:    ' + name + '\n' +
          'Email:   ' + email + '\n' +
          'Subject: ' + (subject || '(none)') + '\n' +
          'Sent:    ' + new Date().toISOString() + '\n\n' +
          '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
          message + '\n' +
          '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
          'Sent via CHeNatEPrep Contact Form'
      });

      return { ok: true, message: 'Your message has been received. We will respond shortly.' };
    } catch (e) {
      Logger.log('[submitContact] ' + e.message);
      return { ok: false, error: 'Message could not be delivered. Please try again later.' };
    }
  }

  return {
    getCurrentUser,
    login,
    register,
    setPassword,
    changePassword,
    resetPassword,
    submitContact
  };
})();
