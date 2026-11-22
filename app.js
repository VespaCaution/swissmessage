/* ============================================================
   app.js — full messenger with calls, voice, announcements
   ============================================================ */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';
import { auth, conversations, messages, subscribeMessages, users, sb } from './supabase.js';
import { CallManager } from './calls.js';

const html = htm.bind(React.createElement);

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('theme', theme);
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) };
}

function App() {
  const { theme, toggle } = useTheme();
  const [user, setUser] = useState(null);
  const [boot, setBoot] = useState(true);
  const [incomingCall, setIncomingCall] = useState(null);

  useEffect(() => {
    (async () => {
      try { setUser(await auth.getCurrentUser()); }
      finally { setBoot(false); }
    })();
  }, []);

  // Global listener for incoming calls via Realtime
  useEffect(() => {
    if (!user) return;
    const ch = sb.channel('calls-global')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_rings' }, (payload) => {
        const r = payload.new;
        if (r.callee_id === user.id && r.status === 'ringing') {
          setIncomingCall(r);
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'call_rings' }, (payload) => {
        const r = payload.new;
        if (r.caller_id === user.id && r.status === 'declined') {
          setIncomingCall(null);
          alert('Call declined');
        }
      })
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [user]);

  if (boot) return html`<div className="min-h-screen flex items-center justify-center">Loading…</div>`;

  return html`
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 dark:border-slate-800 px-4 py-2 flex justify-between items-center">
        <h1 className="text-lg font-bold">Classe</h1>
        <div className="flex items-center gap-2">
          <button onClick=${toggle} className="px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">${theme === 'dark' ? '☀' : '☾'}</button>
          ${user && html`<button onClick=${async () => { await auth.signOut(); setUser(null); }} className="text-sm px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">Logout</button>`}
        </div>
      </header>
      <main className="flex-1">
        ${!user ? html`<${AuthScreen} onAuth=${setUser} />` : html`<${MessengerScreen} user=${user} incomingCall=${incomingCall} setIncomingCall=${setIncomingCall} />`}
      </main>
      ${incomingCall && html`<${IncomingCallModal} call=${incomingCall} user=${user} onClose=${() => setIncomingCall(null)} />`}
    </div>
  `;
}

function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const { user } = mode === 'login'
        ? await auth.signIn({ email, password })
        : await auth.signUp({ email, password, displayName });
      onAuth(user);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return html`
    <div className="max-w-sm mx-auto mt-16 p-6 bg-white dark:bg-slate-900 rounded-xl shadow">
      <h2 className="text-xl font-bold mb-4">${mode === 'login' ? 'Sign in' : 'Sign up'}</h2>
      <form onSubmit=${submit} className="flex flex-col gap-3">
        ${mode === 'signup' && html`<input className="px-3 py-2 border rounded dark:bg-slate-800 dark:border-slate-700" placeholder="Name" value=${displayName} onChange=${(e) => setDisplayName(e.target.value)} required />`}
        <input className="px-3 py-2 border rounded dark:bg-slate-800 dark:border-slate-700" type="email" placeholder="Email" value=${email} onChange=${(e) => setEmail(e.target.value)} required />
        <input className="px-3 py-2 border rounded dark:bg-slate-800 dark:border-slate-700" type="password" placeholder="Password" value=${password} onChange=${(e) => setPassword(e.target.value)} required />
        ${err && html`<div className="text-sm text-red-600">${err}</div>`}
        <button className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50" disabled=${busy}>
          ${busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <button onClick=${() => { setMode(mode === 'login' ? 'signup' : 'login'); setErr(''); }} className="mt-3 text-sm text-indigo-600">
        ${mode === 'login' ? 'No account? Sign up' : 'Have an account? Sign in'}
      </button>
    </div>
  `;
}

function MessengerScreen({ user, incomingCall, setIncomingCall }) {
  const [convs, setConvs] = useState([]);
  const [active, setActive] = useState(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => { setConvs(await conversations.listMine()); }, []);
  useEffect(() => { load(); }, [load]);

  return html`
    <div className="grid grid-cols-1 md:grid-cols-3 h-[calc(100vh-53px)]">
      <aside className="border-r border-slate-200 dark:border-slate-800 flex flex-col">
        <div className="p-3 flex justify-between items-center border-b border-slate-200 dark:border-slate-800">
          <span className="font-semibold">Chats</span>
          <button onClick=${() => setShowNew(true)} className="px-2 py-1 text-sm rounded bg-indigo-600 text-white">+ New</button>
        </div>
        <div className="flex-1 overflow-y-auto">
          ${convs.map((c) => html`
            <button key=${c.id} onClick=${() => setActive(c)}
              className=${`w-full text-left px-3 py-2 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 ${active?.id === c.id ? 'bg-slate-100 dark:bg-slate-800' : ''}`}>
              <div className="font-medium text-sm flex items-center gap-2">
                ${c.name || 'DM'}
                ${c.is_announcement && html`<span className="text-[10px] bg-amber-100 text-amber-700 px-1 rounded">📢</span>`}
              </div>
              <div className="text-xs text-slate-500">${c.memberCount} members</div>
            </button>
          `)}
        </div>
      </aside>
      <section className="md:col-span-2 flex flex-col">
        ${active
          ? html`<${ChatRoom} user=${user} conversation=${active} onLeft=${async () => { setActive(null); await load(); }} />`
          : html`<div className="flex-1 flex items-center justify-center text-slate-500">Select a chat</div>`}
      </section>
      ${showNew && html`<${NewConversationModal} user=${user} onClose=${() => setShowNew(false)} onCreated=${async (c) => { setShowNew(false); await load(); setActive(c); }} />`}
    </div>
  `;
}

function ChatRoom({ user, conversation, onLeft }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [inCall, setInCall] = useState(false);
  const [callType, setCallType] = useState(null); // 'audio' | 'video'
  const [recording, setRecording] = useState(false);
  const [members, setMembers] = useState([]);
  const [showMembers, setShowMembers] = useState(false);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const bottomRef = useRef(null);

  const load = useCallback(async () => {
    setMsgs(await messages.list(conversation.id));
    setMembers(await conversations.getMembers(conversation.id));
  }, [conversation.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const unsub = subscribeMessages(conversation.id, (m) => setMsgs((prev) => prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
    return unsub;
  }, [conversation.id]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  const isAnnouncement = conversation.is_announcement && conversation.owner_id !== user.id;
  const canAddMembers = !conversation.is_announcement; // only owner can remove; anyone can add to non-announcement

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    const m = await messages.send(conversation.id, text);
    setText('');
    setMsgs((prev) => prev.some((x) => x.id === m.id) ? prev : [...prev, m]);
  };

  const sendFile = async (file) => {
    const m = await messages.sendFile(conversation.id, file);
    setMsgs((prev) => prev.some((x) => x.id === m.id) ? prev : [...prev, m]);
  };

  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream);
    mediaRecorderRef.current = mr;
    chunksRef.current = [];
    mr.ondataavailable = (e) => chunksRef.current.push(e.data);
    mr.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' });
      await sendFile({ name: file.name, type: 'audio', rawFile: file });
      stream.getTracks().forEach(t => t.stop());
    };
    mr.start();
    setRecording(true);
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };

  const startCall = async (type) => {
    // Insert a ringing row
    const { data, error } = await sb.from('call_rings').insert({
      conversation_id: conversation.id,
      caller_id: user.id,
      callee_id: members.find(m => m.userId !== user.id)?.userId,
      status: 'ringing',
    }).select().single();
    if (error) { alert('Call failed: ' + error.message); return; }
    setCallType(type);
    setInCall(true);
  };

  if (inCall && callType) return html`<${CallRoom} user=${user} conversation=${conversation} members=${members} callType=${callType} onLeave=${() => { setInCall(false); setCallType(null); }} />`;

  return html`
    <div className="flex flex-col h-full">
      <header className="p-3 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center">
        <span className="font-semibold flex items-center gap-2">
          ${conversation.name || 'DM'}
          ${conversation.is_announcement && html`<span className="text-xs bg-amber-100 text-amber-700 px-1 rounded">Announcement</span>`}
        </span>
        <div className="flex gap-1">
          <button onClick=${() => startCall('audio')} className="px-2 py-1 text-sm rounded hover:bg-slate-100 dark:hover:bg-slate-800">📞</button>
          <button onClick=${() => startCall('video')} className="px-2 py-1 text-sm rounded hover:bg-slate-100 dark:hover:bg-slate-800">🎥</button>
          <button onClick=${() => setShowMembers(true)} className="px-2 py-1 text-sm rounded hover:bg-slate-100 dark:hover:bg-slate-800">👥</button>
          <button onClick=${async () => { if (!confirm('Leave?')) return; await conversations.leave(conversation.id); onLeft(); }} className="px-2 py-1 text-sm rounded hover:bg-slate-100 dark:hover:bg-slate-800">Leave</button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
        ${msgs.map((m) => html`<${MessageBubble} key=${m.id} m=${m} mine=${m.authorId === user.id} />`)}
        <div ref=${bottomRef}></div>
      </div>
      ${!isAnnouncement && html`
        <form onSubmit=${send} className="p-3 border-t border-slate-200 dark:border-slate-800 flex gap-2">
          <${FileButton} onPick=${sendFile} />
          <button type="button" onClick=${recording ? stopRecording : startRecording}
            className=${`px-2 py-1 rounded ${recording ? 'bg-red-600 text-white animate-pulse' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
            ${recording ? '⏹' : '🎤'}
          </button>
          <input className="flex-1 px-3 py-2 border rounded dark:bg-slate-800 dark:border-slate-700" value=${text} onChange=${(e) => setText(e.target.value)} placeholder="Message…" />
          <button className="px-4 py-2 bg-indigo-600 text-white rounded disabled:opacity-50" disabled=${!text.trim()}>Send</button>
        </form>
      `}
      ${isAnnouncement && html`<div className="p-3 border-t border-slate-200 dark:border-slate-800 text-sm text-slate-500 text-center">Only the owner can post in this announcement group.</div>`}
      ${showMembers && html`<${MembersModal} conversation=${conversation} members=${members} user=${user} onClose=${() => setShowMembers(false)} onRefresh=${load} />`}
    </div>
  `;
}

function MessageBubble({ m, mine }) {
  return html`
    <div className=${`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className=${`max-w-[75%] px-3 py-2 rounded-2xl text-sm ${mine ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800'}`}>
        ${!mine && html`<div className="text-[10px] font-semibold opacity-70 mb-0.5">${m.authorName}</div>`}
        ${m.kind === 'file'
          ? m.fileType === 'image'
            ? html`<img src=${m.fileUrl} className="rounded max-h-64 cursor-pointer" onClick=${() => window.open(m.fileUrl, '_blank')} />`
            : m.fileType === 'video'
            ? html`<video src=${m.fileUrl} controls className="rounded max-h-64" />`
            : m.fileType === 'audio'
            ? html`<audio src=${m.fileUrl} controls className="w-full" />`
            : html`<a href=${m.fileUrl} target="_blank" className="underline">📎 ${m.fileName}</a>`
          : html`<div className="whitespace-pre-wrap break-words">${m.content}</div>`}
      </div>
    </div>
  `;
}

function FileButton({ onPick }) {
  const inputRef = useRef(null);
  const handle = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { alert('File too large (max 10MB)'); return; }
    const type = f.type.startsWith('image/') ? 'image' : f.type === 'application/pdf' ? 'pdf' : f.type.startsWith('audio/') ? 'audio' : f.type.startsWith('video/') ? 'video' : 'other';
    onPick({ name: f.name, type, rawFile: f });
    e.target.value = '';
  };
  return html`
    <div>
      <input ref=${inputRef} type="file" className="hidden" onChange=${handle} />
      <button type="button" onClick=${() => inputRef.current?.click()} className="px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">📎</button>
    </div>
  `;
}

function CallRoom({ user, conversation, members, callType, onLeave }) {
  const [caller, setCaller] = useState(null);
  const [peers, setPeers] = useState({});
  const [status, setStatus] = useState('connecting');
  const localVideo = useRef(null);
  const remoteVideos = useRef({});

  useEffect(() => {
    const remoteUser = members.find(m => m.userId !== user.id);
    if (!remoteUser) { onLeave(); return; }

    const mgr = new CallManager({
      roomId: `conv-${conversation.id}`,
      userId: user.id,
      peerId: remoteUser.userId,
      onPeerStream: (peerId, stream) => {
        setPeers((prev) => ({ ...prev, [peerId]: stream }));
        setStatus('connected');
      },
      onPeerLeave: (peerId) => {
        setPeers((prev) => { const n = { ...prev }; delete n[peerId]; return n; });
        setStatus('ended');
      },
      onError: (e) => { console.error('[Call]', e); setStatus('error'); },
    });
    setCaller(mgr);
    (async () => {
      const stream = await mgr.start({ audio: true, video: callType === 'video' });
      if (stream && localVideo.current) localVideo.current.srcObject = stream;
    })();
    return () => { mgr.hangup(); };
  }, [conversation.id, user.id, callType]);

  useEffect(() => {
    Object.entries(peers).forEach(([pid, stream]) => {
      const el = remoteVideos.current[pid];
      if (el && el.srcObject !== stream) el.srcObject = stream;
    });
  }, [peers]);

  return html`
    <div className="flex flex-col h-full bg-slate-900 text-white">
      <header className="p-3 flex justify-between">
        <span>Call — ${conversation.name || 'DM'} (${status})</span>
        <div className="flex gap-2">
          <button onClick=${() => caller?.toggleAudio()} className="px-2 py-1 rounded bg-white/10 hover:bg-white/20">🎤</button>
          ${callType === 'video' && html`<button onClick=${() => caller?.toggleVideo()} className="px-2 py-1 rounded bg-white/10 hover:bg-white/20">🎥</button>`}
          <button onClick=${() => caller?.shareScreen()} className="px-2 py-1 rounded bg-white/10 hover:bg-white/20">🖥</button>
          <button onClick=${async () => { await caller?.hangup(); onLeave(); }} className="px-2 py-1 rounded bg-red-600 hover:bg-red-700">Hangup</button>
        </div>
      </header>
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-2 p-2">
        <video ref=${localVideo} autoPlay muted playsInline className="w-full h-full object-cover rounded bg-black" />
        ${Object.entries(peers).map(([pid, stream]) => html`
          <video key=${pid} ref=${(el) => { if (el) { remoteVideos.current[pid] = el; el.srcObject = stream; } }} autoPlay playsInline className="w-full h-full object-cover rounded bg-black" />
        `)}
        ${Object.keys(peers).length === 0 && html`<div className="flex items-center justify-center text-slate-400 text-sm">Connecting…</div>`}
      </div>
    </div>
  `;
}

function IncomingCallModal({ call, user, onClose }) {
  const accept = async () => {
    const { error } = await sb.from('call_rings').update({ status: 'accepted' }).eq('id', call.id);
    if (error) { alert(error.message); return; }
    // The caller's ChatRoom will see the update and join; to keep simple, we just alert
    alert('Accepted. Open the chat to join the call.');
    onClose();
  };
  const decline = async () => {
    await sb.from('call_rings').update({ status: 'declined' }).eq('id', call.id);
    onClose();
  };
  return html`
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-slate-900 rounded-xl p-6 max-w-sm w-full">
        <h3 className="text-lg font-bold mb-2">Incoming call</h3>
        <p className="text-sm text-slate-500 mb-4">From user ${call.caller_id}</p>
        <div className="flex gap-2">
          <button onClick=${accept} className="flex-1 px-4 py-2 bg-green-600 text-white rounded">Accept</button>
          <button onClick=${decline} className="flex-1 px-4 py-2 bg-red-600 text-white rounded">Decline</button>
        </div>
      </div>
    </div>
  `;
}

function MembersModal({ conversation, members, user, onClose, onRefresh }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);

  const search = async (q) => {
    setQuery(q);
    if (q.length < 2) { setResults([]); return; }
    const r = await users.search(q);
    setResults(r.filter((u) => !members.some((m) => m.userId === u.id)));
  };

  const add = async (u) => {
    await conversations.addMembers(conversation.id, [u.id]);
    setQuery(''); setResults([]);
    await onRefresh();
  };

  const remove = async (m) => {
    const { error } = await sb.from('conversation_members').delete().eq('id', m.id);
    if (error) { alert(error.message); return; }
    await onRefresh();
  };

  const isOwner = conversation.owner_id === user.id;

  return html`
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white dark:bg-slate-900 rounded-xl max-w-md w-full p-4 flex flex-col gap-3">
        <h2 className="text-lg font-bold">Members</h2>
        <div className="max-h-48 overflow-y-auto flex flex-col gap-1">
          ${members.map((m) => html`
            <div key=${m.id} className="flex justify-between items-center px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">
              <span className="text-sm">${m.displayName}</span>
              ${isOwner && m.userId !== user.id && html`<button onClick=${() => remove(m)} className="text-xs text-red-500">Remove</button>`}
            </div>
          `)}
        </div>
        <input className="px-3 py-2 border rounded dark:bg-slate-800 dark:border-slate-700" placeholder="Search users to add…" value=${query} onChange=${(e) => search(e.target.value)} />
        ${results.length > 0 && html`<div className="max-h-32 overflow-y-auto flex flex-col gap-1">
          ${results.map((r) => html`<button key=${r.id} onClick=${() => add(r)} className="text-left px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">${r.displayName}</button>`)}
        </div>`}
        <div className="flex justify-end"><button onClick=${onClose} className="px-3 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">Close</button></div>
      </div>
    </div>
  `;
}

function NewConversationModal({ user, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState([]);
  const [announcement, setAnnouncement] = useState(false);

  const search = async (q) => {
    setQuery(q);
    if (q.length < 2) { setResults([]); return; }
    setResults((await users.search(q)).filter((u) => u.id !== user.id));
  };

  const create = async () => {
    try {
      const isDM = selected.length === 1 && !name.trim() && !announcement;
      if (isDM) {
        const existing = await conversations.findDM(selected[0].id);
        if (existing) return onCreated(existing);
        const c = await conversations.create({ name: null, type: 'dm', memberIds: [selected[0].id], is_announcement: false });
        return onCreated(c);
      }
      const c = await conversations.create({
        name: name.trim() || 'New group',
        type: 'group',
        memberIds: selected.map((s) => s.id),
        is_announcement: announcement,
      });
      onCreated(c);
    } catch (err) {
      console.error('[Create]', err);
      alert('Failed to create: ' + (err.message || JSON.stringify(err)));
    }
  };

  return html`
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white dark:bg-slate-900 rounded-xl max-w-md w-full p-4 flex flex-col gap-3">
        <h2 className="text-lg font-bold">New conversation</h2>
        <input className="px-3 py-2 border rounded dark:bg-slate-800 dark:border-slate-700" placeholder="Group name (blank for DM)" value=${name} onChange=${(e) => setName(e.target.value)} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked=${announcement} onChange=${(e) => setAnnouncement(e.target.checked)} />
          Announcement group (only creator can message)
        </label>
        <input className="px-3 py-2 border rounded dark:bg-slate-800 dark:border-slate-700" placeholder="Search users…" value=${query} onChange=${(e) => search(e.target.value)} />
        <div className="max-h-48 overflow-y-auto flex flex-col gap-1">
          ${results.map((r) => html`
            <button key=${r.id} onClick=${() => setSelected((s) => s.some((x) => x.id === r.id) ? s.filter((x) => x.id !== r.id) : [...s, r])}
              className=${`text-left px-2 py-1 rounded ${selected.some((x) => x.id === r.id) ? 'bg-indigo-600 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
              ${r.displayName}
            </button>
          `)}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick=${onClose} className="px-3 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">Cancel</button>
          <button onClick=${create} className="px-3 py-1 rounded bg-indigo-600 text-white disabled:opacity-50" disabled=${selected.length === 0 && !name.trim()}>Create</button>
        </div>
      </div>
    </div>
  `;
}

createRoot(document.getElementById('root')).render(html`<${App} />`);
