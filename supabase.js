/* ============================================================
   supabase.js — chat backend (auth, messages, files, realtime)
   ============================================================ */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const sb = createClient(
  'https://prnyaegqyqenganlmxih.supabase.co',
  'sb_publishable_gX7yR83JPQRs7ym49h2RRw_6gI9O8JS',
  { auth: { persistSession: true, autoRefreshToken: true } }
);

const BUCKET = 'attachments';

async function currentUser() {
  const { data } = await sb.auth.getUser();
  return data?.user ?? null;
}

async function uploadFile(path, file) {
  const { error } = await sb.storage.from(BUCKET).upload(path, file, { upsert: false });
  if (error) throw error;
  const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

function extOf(name) {
  const parts = name.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : 'bin';
}

// ============================================================
// AUTH
// ============================================================
export const auth = {
  async signUp({ email, password, displayName }) {
    const { data, error } = await sb.auth.signUp({
      email, password, options: { data: { display_name: displayName } },
    });
    if (error) throw error;
    return { user: { id: data.user.id, email: data.user.email, displayName } };
  },
  async signIn({ email, password }) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const { data: prof } = await sb.from('profiles').select('*').eq('id', data.user.id).single();
    return { user: { id: data.user.id, email: data.user.email, displayName: prof?.display_name || email } };
  },
  async signOut() { await sb.auth.signOut(); return true; },
  async getCurrentUser() {
    const u = await currentUser();
    if (!u) return null;
    const { data: prof } = await sb.from('profiles').select('*').eq('id', u.id).single();
    return { id: u.id, email: u.email, displayName: prof?.display_name || u.email };
  },
};

// ============================================================
// CONVERSATIONS (replaces classes)
// ============================================================
export const conversations = {
  async listMine() {
    const u = await currentUser();
    const { data, error } = await sb.from('conversation_members')
      .select('conversations!inner(id, name, type, owner_id, created_at)')
      .eq('user_id', u.id);
    if (error) throw error;
    const out = [];
    for (const m of data) {
      const c = m.conversations;
      const { count } = await sb.from('conversation_members').select('*', { count: 'exact', head: true }).eq('conversation_id', c.id);
      out.push({ ...c, memberCount: count ?? 0 });
    }
    return out;
  },

  async create({ name, type = 'group', memberIds = [] }) {
    const u = await currentUser();
    const { data, error } = await sb.from('conversations')
      .insert({ name, type, owner_id: u.id })
      .select().single();
    if (error) throw error;
    const all = Array.from(new Set([u.id, ...memberIds]));
    await sb.from('conversation_members').insert(all.map((id) => ({ conversation_id: data.id, user_id: id })));
    return { ...data, memberCount: all.length };
  },

  async findDM(peerId) {
    const u = await currentUser();
    const { data: myConvs } = await sb.from('conversation_members').select('conversation_id').eq('user_id', u.id);
    if (!myConvs?.length) return null;
    const myIds = myConvs.map((x) => x.conversation_id);
    const { data: peerConvs } = await sb.from('conversation_members').select('conversation_id').eq('user_id', peerId).in('conversation_id', myIds);
    if (!peerConvs?.length) return null;
    for (const { conversation_id } of peerConvs) {
      const { data: conv } = await sb.from('conversations').select('*').eq('id', conversation_id).eq('type', 'dm').maybeSingle();
      if (conv) return conv;
    }
    return null;
  },

  async getById(id) {
    const { data: c } = await sb.from('conversations').select('*').eq('id', id).single();
    if (!c) return null;
    const { count } = await sb.from('conversation_members').select('*', { count: 'exact', head: true }).eq('conversation_id', id);
    return { ...c, memberCount: count ?? 0 };
  },

  async getMembers(id) {
    const { data, error } = await sb.from('conversation_members')
      .select('id, user_id, joined_at, profiles!inner(display_name)')
      .eq('conversation_id', id);
    if (error) throw error;
    return data.map((m) => ({
      id: m.id, userId: m.user_id, displayName: m.profiles?.display_name, joinedAt: m.joined_at,
    }));
  },

  async addMembers(id, userIds) {
    for (const uid of userIds) {
      const { error } = await sb.from('conversation_members').insert({ conversation_id: id, user_id: uid });
      if (error && error.code !== '23505') throw error;
    }
    return true;
  },

  async leave(id) {
    const u = await currentUser();
    await sb.from('conversation_members').delete().eq('conversation_id', id).eq('user_id', u.id);
    return true;
  },

  async delete(id) {
    await sb.from('conversations').delete().eq('id', id);
    return true;
  },
};

// ============================================================
// MESSAGES
// ============================================================
export const messages = {
  async list(conversationId) {
    const { data, error } = await sb.from('messages')
      .select('*, profiles!inner(display_name)')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data.map((m) => ({
      id: m.id, conversationId: m.conversation_id, authorId: m.author_id,
      kind: m.kind, content: m.content,
      fileUrl: m.file_url, fileName: m.file_name, fileType: m.file_type,
      createdAt: m.created_at, authorName: m.profiles?.display_name,
    }));
  },

  async send(conversationId, content) {
    const u = await currentUser();
    const { data, error } = await sb.from('messages').insert({
      conversation_id: conversationId, author_id: u.id, kind: 'text', content,
    }).select('id, created_at').single();
    if (error) throw error;
    const { data: prof } = await sb.from('profiles').select('display_name').eq('id', u.id).single();
    return {
      id: data.id, conversationId, authorId: u.id, kind: 'text',
      content, createdAt: data.created_at, authorName: prof?.display_name,
    };
  },

  async sendFile(conversationId, file) {
    const u = await currentUser();
    const path = `chat/${conversationId}/${crypto.randomUUID()}.${extOf(file.name)}`;
    const url = await uploadFile(path, file.rawFile);
    const { data, error } = await sb.from('messages').insert({
      conversation_id: conversationId, author_id: u.id, kind: 'file',
      file_url: url, file_name: file.name, file_type: file.type,
    }).select('id, created_at').single();
    if (error) throw error;
    const { data: prof } = await sb.from('profiles').select('display_name').eq('id', u.id).single();
    return {
      id: data.id, conversationId, authorId: u.id, kind: 'file',
      fileUrl: url, fileName: file.name, fileType: file.type,
      createdAt: data.created_at, authorName: prof?.display_name,
    };
  },
};

export function subscribeMessages(conversationId, onMessage) {
  const ch = sb.channel(`conv:${conversationId}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
      async (payload) => {
        const { data: prof } = await sb.from('profiles').select('display_name').eq('id', payload.new.author_id).single();
        onMessage({
          id: payload.new.id, conversationId: payload.new.conversation_id,
          authorId: payload.new.author_id, kind: payload.new.kind,
          content: payload.new.content,
          fileUrl: payload.new.file_url, fileName: payload.new.file_name, fileType: payload.new.file_type,
          createdAt: payload.new.created_at, authorName: prof?.display_name,
        });
      })
    .subscribe();
  return () => sb.removeChannel(ch);
}

// ============================================================
// USERS (for DM searching)
// ============================================================
export const users = {
  async search(query) {
    const { data, error } = await sb.from('profiles')
      .select('id, display_name')
      .ilike('display_name', `%${query}%`)
      .limit(10);
    if (error) throw error;
    return data.map((u) => ({ id: u.id, displayName: u.display_name }));
  },
};
