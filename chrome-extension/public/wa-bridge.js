/**
 * WA-JS Bridge — runs in WhatsApp Web's MAIN world.
 * Injected by the content script via <script> tag.
 * Communicates with the content script via window.postMessage.
 */
(function () {
  'use strict';

  // Prevent double injection
  if (window.__WA_BRIDGE_LOADED) return;
  window.__WA_BRIDGE_LOADED = true;

  var ORIGIN = 'https://web.whatsapp.com';
  var wppReady = false;
  var wppFailed = false;

  function loadWaJs(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Failed to load WA-JS')); };
      document.head.appendChild(script);
    });
  }

  async function init(waJsUrl) {
    try {
      await loadWaJs(waJsUrl);

      // Wait for WPP to be ready (up to 30 seconds)
      for (var i = 0; i < 60; i++) {
        if (window.WPP && window.WPP.isReady) {
          wppReady = true;
          window.postMessage({ type: 'WA_BRIDGE_READY', source: 'wa-bridge' }, ORIGIN);
          return;
        }
        await new Promise(function (r) { setTimeout(r, 500); });
      }

      wppFailed = true;
      window.postMessage({ type: 'WA_BRIDGE_FAILED', error: 'WPP not ready after 30s', source: 'wa-bridge' }, ORIGIN);
    } catch (err) {
      wppFailed = true;
      window.postMessage({ type: 'WA_BRIDGE_FAILED', error: String(err), source: 'wa-bridge' }, ORIGIN);
    }
  }

  window.addEventListener('message', async function (event) {
    // Only accept messages from our own origin
    if (event.origin !== ORIGIN) return;
    if (!event.data || event.data.source === 'wa-bridge') return;

    if (event.data.type === 'WA_INIT') {
      var url = event.data.waJsUrl;
      // Only load scripts from chrome-extension:// URLs
      if (typeof url !== 'string' || !url.startsWith('chrome-extension://')) return;
      init(url);
      return;
    }

    if (event.data.type === 'WA_OPEN_CHAT') {
      if (!wppReady) {
        window.postMessage({
          type: 'WA_CHAT_RESULT',
          id: event.data.id,
          success: false,
          error: wppFailed ? 'WA-JS failed to initialize' : 'WA-JS not ready yet',
          source: 'wa-bridge'
        }, ORIGIN);
        return;
      }

      var phone = event.data.phone;
      var wid = phone.replace(/[\s\-+]/g, '') + '@c.us';

      try {
        if (typeof window.WPP.chat.openChatBottom === 'function') {
          await window.WPP.chat.openChatBottom(wid);
        } else if (typeof window.WPP.chat.find === 'function') {
          await window.WPP.chat.find(wid);
        } else {
          throw new Error('No suitable WPP.chat function available');
        }

        window.postMessage({
          type: 'WA_CHAT_RESULT',
          id: event.data.id,
          success: true,
          source: 'wa-bridge'
        }, ORIGIN);
      } catch (err) {
        window.postMessage({
          type: 'WA_CHAT_RESULT',
          id: event.data.id,
          success: false,
          error: String(err.message || err),
          source: 'wa-bridge'
        }, ORIGIN);
      }
    }

    if (event.data.type === 'WA_SEND_TEXT') {
      var sReqId = event.data.id;
      function sendReply(success, error, errorCode) {
        window.postMessage({
          type: 'WA_SEND_RESULT',
          id: sReqId,
          success: success,
          error: error || '',
          errorCode: errorCode || '',
          source: 'wa-bridge'
        }, ORIGIN);
      }
      if (!wppReady) {
        sendReply(false, wppFailed ? 'WA-JS failed to initialize' : 'WA-JS not ready yet', 'BRIDGE_NOT_READY');
        return;
      }
      var sPhone = String(event.data.phone || '').replace(/[\s\-+]/g, '');
      var sWid = sPhone + '@c.us';
      var sText = String(event.data.text || '');
      var sSimulate = !!event.data.simulateTyping;
      try {
        if (sSimulate && typeof window.WPP.chat.markIsComposing === 'function') {
          // Show "typing..." indicator while we wait, proportional to message length
          var thinkMs = Math.min(8000, Math.max(1500, sText.length * 35));
          try { await window.WPP.chat.markIsComposing(sWid, thinkMs); } catch (_) {}
          await new Promise(function (r) { setTimeout(r, thinkMs); });
        }
        // Race the send against an explicit ack timeout so we can distinguish
        // "WA accepted the message" from "WA never confirmed delivery" (ban-like signal).
        var sendPromise = window.WPP.chat.sendTextMessage(sWid, sText, { waitForAck: true });
        var ackTimeoutMs = 25000;
        var timeoutPromise = new Promise(function (_, rej) {
          setTimeout(function () { rej(new Error('ACK_TIMEOUT')); }, ackTimeoutMs);
        });
        await Promise.race([sendPromise, timeoutPromise]);
        sendReply(true);
      } catch (err) {
        var msg = String(err && err.message || err);
        var code = 'SEND_ERROR';
        if (/ACK_TIMEOUT/.test(msg)) code = 'ACK_TIMEOUT';
        else if (/blocked|forbidden|banned|not authorized|prohibited|spam/i.test(msg)) code = 'BLOCKED';
        else if (/network|fetch|disconnected|offline/i.test(msg)) code = 'NETWORK';
        else if (/timeout|timed out/i.test(msg)) code = 'TIMEOUT';
        sendReply(false, msg, code);
      }
      return;
    }

    if (event.data.type === 'WA_LIST_SAVED_CONTACTS') {
      var lcReqId = event.data.id;
      function lcReply(success, phones, error) {
        window.postMessage({
          type: 'WA_SAVED_CONTACTS_RESULT',
          id: lcReqId,
          success: success,
          phones: phones || [],
          error: error || '',
          source: 'wa-bridge'
        }, ORIGIN);
      }
      if (!wppReady) {
        lcReply(false, [], wppFailed ? 'WA-JS failed to initialize' : 'WA-JS not ready yet');
        return;
      }
      try {
        var phones = {};
        // Saved contacts (from address book)
        try {
          var contacts = await window.WPP.contact.list();
          for (var ci = 0; ci < contacts.length; ci++) {
            var co = contacts[ci];
            var coid = co && co.id;
            var coser = (coid && coid._serialized) || '';
            if (coser.indexOf('@c.us') === -1) continue;
            var conum = (coid.user || coser.split('@')[0] || '').replace(/\D/g, '');
            if (conum) phones[conum] = true;
          }
        } catch (e) { console.warn('[SendStack] contact.list failed', e); }
        // Open chats (contacts you've talked to even if not saved)
        try {
          var chats = await window.WPP.chat.list({ onlyUsers: true });
          for (var chi = 0; chi < chats.length; chi++) {
            var ch = chats[chi];
            var chid = ch && ch.id;
            var chser = (chid && chid._serialized) || '';
            if (chser.indexOf('@c.us') === -1) continue;
            var chnum = (chid.user || chser.split('@')[0] || '').replace(/\D/g, '');
            if (chnum) phones[chnum] = true;
          }
        } catch (e) { console.warn('[SendStack] chat.list failed', e); }
        lcReply(true, Object.keys(phones));
      } catch (err) {
        lcReply(false, [], String(err && err.message || err));
      }
      return;
    }

    if (event.data.type === 'WA_EXTRACT') {
      var reqId = event.data.id;
      var mode = event.data.mode; // 'current-group' | 'list-groups' | 'pick-group' | 'all-chats'
      var pickedGroupId = event.data.groupId || null;

      function reply(payload) {
        window.postMessage(Object.assign({
          type: 'WA_EXTRACT_RESULT',
          id: reqId,
          source: 'wa-bridge'
        }, payload), ORIGIN);
      }

      if (!wppReady) {
        reply({ success: false, error: wppFailed ? 'WA-JS failed to initialize' : 'WA-JS not ready yet' });
        return;
      }

      // Read first non-empty string from a list of candidate values.
      function firstName() {
        for (var i = 0; i < arguments.length; i++) {
          var v = arguments[i];
          if (typeof v === 'string' && v.trim()) return v.trim();
        }
        return '';
      }

      function nameOf(widOrEntry) {
        try {
          // If passed a participant/entry object (has .id), check its own fields first
          if (widOrEntry && typeof widOrEntry === 'object' && widOrEntry.id) {
            var entry = widOrEntry;
            var direct = firstName(entry.name, entry.pushname, entry.formattedName, entry.displayName, entry.verifiedName, entry.notifyName);
            if (direct) return direct;
            if (entry.contact) {
              var fromContact = firstName(
                entry.contact.name,
                entry.contact.pushname,
                entry.contact.formattedName,
                entry.contact.displayName,
                entry.contact.verifiedName,
                entry.contact.notifyName
              );
              if (fromContact) return fromContact;
            }
            var serialized = (entry.id && entry.id._serialized) || '';
            if (serialized) {
              var c = window.WPP.contact.get(serialized);
              if (c) {
                var fromLookup = firstName(c.name, c.pushname, c.formattedName, c.displayName, c.verifiedName, c.notifyName);
                if (fromLookup) return fromLookup;
              }
            }
            return '';
          }
          // Plain WID string path (legacy)
          var c2 = window.WPP.contact.get(widOrEntry);
          if (!c2) return '';
          return firstName(c2.name, c2.pushname, c2.formattedName, c2.displayName, c2.verifiedName, c2.notifyName);
        } catch (_) { return ''; }
      }

      // STRICT: only accept @c.us WIDs as phone numbers. Reject @lid, @g.us,
      // bare digits, and anything else — these are not real phone numbers and
      // returning them produces garbage CSVs.
      function fromWid(w) {
        if (!w) return null;
        if (typeof w === 'string') {
          if (!/@c\.us$/.test(w)) return null;
          var n = w.split('@')[0];
          return /^\d+$/.test(n) ? n : null;
        }
        // Object form
        if (w._serialized) return fromWid(w._serialized);
        if (w.user && (w.server === 'c.us' || w._isMe === false) && /^\d+$/.test(w.user)) {
          // Defensive: only accept if explicitly tagged c.us
          return w.server === 'c.us' ? w.user : null;
        }
        return null;
      }

      // Resolve a participant/contact to a digit-only phone number (no +).
      // Handles @c.us directly and @lid via several fallback paths because
      // recent WhatsApp privacy changes hide phones behind Linked IDs in groups.
      function resolvePhone(entry) {
        if (!entry) return null;

        var pid = entry.id || entry;
        var serialized = (pid && pid._serialized) || (typeof pid === 'string' ? pid : '');

        // Direct phone WID
        var direct = fromWid(pid);
        if (direct) return direct;

        // 1) Participant's own phoneNumber field
        if (entry.phoneNumber) {
          var p1 = fromWid(entry.phoneNumber);
          if (p1) return p1;
        }

        // 2) Participant.contact (common in newer WA-JS)
        if (entry.contact) {
          if (entry.contact.phoneNumber) {
            var p2a = fromWid(entry.contact.phoneNumber);
            if (p2a) return p2a;
          }
          if (entry.contact.id) {
            var p2b = fromWid(entry.contact.id);
            if (p2b) return p2b;
          }
        }

        // 3) WPP.contact.get on the lid serialized — may yield linked phone
        try {
          var c = window.WPP.contact.get(serialized);
          if (c) {
            if (c.phoneNumber) {
              var p3a = fromWid(c.phoneNumber);
              if (p3a) return p3a;
            }
            if (c.id) {
              var p3b = fromWid(c.id);
              if (p3b) return p3b;
            }
          }
        } catch (_) {}

        // 4) Internal LID→phone utilities (best-effort across WA-JS versions)
        try {
          var W = window.WPP.whatsapp || {};
          var candidates = [
            W.WidToJid && W.WidToJid.lidToPn,
            W.LidUtils && W.LidUtils.getPhoneNumber,
            W.LidUtils && W.LidUtils.getPnFromLid,
            W.functions && W.functions.getPhoneIdFromLid,
          ].filter(Boolean);
          for (var k = 0; k < candidates.length; k++) {
            try {
              var r = candidates[k](pid);
              var p4 = fromWid(r);
              if (p4) return p4;
            } catch (_) {}
          }
        } catch (_) {}

        // 5) Walk own enumerable string-valued props for any @c.us reference
        try {
          for (var key in entry) {
            var v = entry[key];
            if (typeof v === 'string' && /@c\.us$/.test(v)) {
              var p5 = fromWid(v);
              if (p5) return p5;
            } else if (v && typeof v === 'object' && v._serialized && /@c\.us$/.test(v._serialized)) {
              var p5b = fromWid(v);
              if (p5b) return p5b;
            }
          }
        } catch (_) {}

        return null;
      }

      async function extractFromGroup(groupId, groupName) {
        var participants = await window.WPP.group.getParticipants(groupId);
        var rows = [];
        var unresolved = 0;
        var firstUnresolved = null;
        for (var i = 0; i < participants.length; i++) {
          var p = participants[i];
          var phone = resolvePhone(p);
          var serialized = (p && p.id && p.id._serialized) || '';
          if (!phone) {
            unresolved++;
            if (!firstUnresolved) firstUnresolved = p;
            continue;
          }
          rows.push({ phone: '+' + phone, name: nameOf(p), source: 'Group: ' + groupName });
        }
        if (unresolved > 0 && firstUnresolved) {
          var fp = firstUnresolved;
          var fpSer = (fp && fp.id && fp.id._serialized) || '';
          console.warn('[SendStack] ' + unresolved + ' participants unresolved (likely @lid privacy mode). Diagnostic dump:');
          console.warn('  participant keys:', Object.keys(fp));
          console.warn('  participant:', fp);
          console.warn('  id keys:', fp.id ? Object.keys(fp.id) : '(no id)');
          console.warn('  id:', fp.id);
          try {
            var dc = window.WPP.contact.get(fpSer);
            if (dc) {
              console.warn('  contact keys:', Object.keys(dc));
              console.warn('  contact:', dc);
              console.warn('  contact.phoneNumber:', dc.phoneNumber);
              console.warn('  contact.id:', dc.id);
            }
          } catch (e) {
            console.warn('  contact lookup error:', e);
          }
          // List available WPP.whatsapp utilities to discover lid->pn helpers
          try {
            var W = window.WPP.whatsapp || {};
            var topKeys = Object.keys(W).filter(function (k) {
              return /lid|wid|jid|user|phone/i.test(k);
            });
            console.warn('  WPP.whatsapp keys (filtered):', topKeys);
          } catch (_) {}
        }
        return { rows: rows, total: participants.length, unresolved: unresolved };
      }

      function chatTitle(ch) {
        return ch.name || ch.formattedTitle || ch.contact && (ch.contact.name || ch.contact.pushname) || (ch.id && ch.id.user) || 'Unknown';
      }

      try {
        if (mode === 'list-groups') {
          var groupChats = await window.WPP.chat.list({ onlyGroups: true });
          var groups = [];
          for (var g = 0; g < groupChats.length; g++) {
            var gc = groupChats[g];
            if (!gc || !gc.id) continue;
            var gid = gc.id._serialized || '';
            if (gid.indexOf('@g.us') === -1) continue;
            var size = (gc.groupMetadata && gc.groupMetadata.participants && gc.groupMetadata.participants.length) || 0;
            groups.push({ id: gid, name: chatTitle(gc), size: size });
          }
          // Sort by name for predictable ordering
          groups.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
          reply({ success: true, groups: groups });
          return;
        }

        if (mode === 'current-group') {
          var active = window.WPP.chat.getActiveChat && window.WPP.chat.getActiveChat();
          if (!active || !active.id) throw new Error('No chat is currently open');
          var isGroup = active.id.isGroup === true || (active.id._serialized && active.id._serialized.indexOf('@g.us') !== -1);
          if (!isGroup) throw new Error('The open chat is not a group — open a group first');
          var res = await extractFromGroup(active.id._serialized, chatTitle(active));
          console.log('[SendStack] current-group resolved:', res.rows.length, 'unresolved:', res.unresolved);
          reply({ success: true, contacts: res.rows, unresolved: res.unresolved, total: res.total });
          return;
        }

        if (mode === 'pick-group') {
          if (!pickedGroupId) throw new Error('No group selected');
          // Find the group object so we can label it
          var allGroups = await window.WPP.chat.list({ onlyGroups: true });
          var picked = null;
          for (var pg = 0; pg < allGroups.length; pg++) {
            if (allGroups[pg].id && allGroups[pg].id._serialized === pickedGroupId) { picked = allGroups[pg]; break; }
          }
          var pickedName = picked ? chatTitle(picked) : pickedGroupId;
          var pres = await extractFromGroup(pickedGroupId, pickedName);
          console.log('[SendStack] pick-group resolved:', pres.rows.length, 'unresolved:', pres.unresolved);
          reply({ success: true, contacts: pres.rows, unresolved: pres.unresolved, total: pres.total });
          return;
        }
        if (mode === 'all-chats') {
          var allRows = [];
          var seen = {};

          // 1) Direct chats
          var dms = await window.WPP.chat.list({ onlyUsers: true });
          for (var d = 0; d < dms.length; d++) {
            var dm = dms[d];
            if (!dm || !dm.id) continue;
            var dsid = dm.id._serialized || '';
            if (dsid.indexOf('@c.us') === -1) continue;
            var dphone = dm.id.user || dsid.split('@')[0] || '';
            if (!dphone) continue;
            var key = '+' + dphone;
            if (seen[key]) continue;
            seen[key] = true;
            allRows.push({ phone: key, name: chatTitle(dm), source: 'Direct chat' });
          }

          // 2) Every group's participants
          var grps = await window.WPP.chat.list({ onlyGroups: true });
          for (var gi = 0; gi < grps.length; gi++) {
            var grp = grps[gi];
            if (!grp || !grp.id) continue;
            var gserial = grp.id._serialized;
            if (!gserial || gserial.indexOf('@g.us') === -1) continue;
            try {
              var gres = await extractFromGroup(gserial, chatTitle(grp));
              for (var r = 0; r < gres.rows.length; r++) {
                var row = gres.rows[r];
                if (seen[row.phone]) continue; // first source wins
                seen[row.phone] = true;
                allRows.push(row);
              }
            } catch (e) {
              console.warn('[SendStack] Skipped group', chatTitle(grp), e);
            }
          }

          console.log('[SendStack] all-chats resolved:', allRows.length);
          reply({ success: true, contacts: allRows });
          return;
        }

        throw new Error('Unknown extract mode: ' + mode);
      } catch (err) {
        reply({ success: false, error: String(err && err.message || err) });
      }
    }
  });
})();
