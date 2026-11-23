/* ============================================================
   calls.js — WebRTC with perfect negotiation
   ============================================================ */

import { joinRoom } from 'trystero';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class CallManager {
  constructor({ roomId, userId, peerId, onPeerStream, onPeerLeave, onError }) {
    this.roomId = roomId;
    this.userId = userId;
    this.peerId = peerId;
    this.isPolite = userId > peerId; // larger ID is polite
    this.onPeerStream = onPeerStream || (() => {});
    this.onPeerLeave = onPeerLeave || (() => {});
    this.onError = onError || ((e) => console.error(e));
    this.room = null;
    this.localStream = null;
    this.peerConnection = null;
    this.makingOffer = false;
    this.ignoreOffer = false;
  }

  async start({ audio = true, video = true } = {}) {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio, video });
    } catch (err) { this.onError(err); return null; }

    this.room = joinRoom({ appId: 'classe-messenger' }, this.roomId);
    this.setupPeerConnection();

    if (this.localStream) {
      this.room.addStream(this.localStream);
    }

    this.room.onPeerStream((stream, peerId) => {
      if (peerId === this.peerId) this.onPeerStream(peerId, stream);
    });

    this.room.onPeerJoin((peerId) => {
      if (peerId === this.peerId && this.localStream) {
        this.room.addStream(this.localStream, peerId);
      }
    });

    this.room.onPeerLeave((peerId) => {
      if (peerId === this.peerId) this.onPeerLeave(peerId);
    });

    return this.localStream;
  }

  setupPeerConnection() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peerConnection = pc;

    // Send local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => pc.addTrack(track, this.localStream));
    }

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.room.send({ type: 'description', description: pc.localDescription }, this.peerId);
      } catch (err) { this.onError(err); }
      finally { this.makingOffer = false; }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.room.send({ type: 'candidate', candidate }, this.peerId);
    };

    pc.ontrack = (event) => {
      this.onPeerStream(this.peerId, event.streams[0]);
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        this.onPeerLeave(this.peerId);
      }
    };

    // Listen for signaling messages
    this.room.onMessage((data, peerId) => {
      if (peerId !== this.peerId) return;
      this.handleSignal(data);
    });
  }

  async handleSignal({ description, candidate }) {
    const pc = this.peerConnection;
    if (!pc) return;

    try {
      if (description) {
        const offerCollision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.isPolite && offerCollision;
        if (this.ignoreOffer) return;

        if (offerCollision) {
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' }),
            pc.setRemoteDescription(description),
          ]);
        } else {
          await pc.setRemoteDescription(description);
        }

        if (description.type === 'offer') {
          await pc.setLocalDescription();
          this.room.send({ type: 'description', description: pc.localDescription }, this.peerId);
        }
      } else if (candidate) {
        try { await pc.addIceCandidate(candidate); } catch (err) { if (!this.ignoreOffer) throw err; }
      }
    } catch (err) { this.onError(err); }
  }

  toggleAudio() {
    const tracks = this.localStream?.getAudioTracks() || [];
    tracks.forEach((t) => (t.enabled = !t.enabled));
    return tracks[0]?.enabled;
  }

  toggleVideo() {
    const tracks = this.localStream?.getVideoTracks() || [];
    tracks.forEach((t) => (t.enabled = !t.enabled));
    return tracks[0]?.enabled;
  }

  async shareScreen() {
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const videoTrack = screen.getVideoTracks()[0];
      const sender = this.peerConnection?.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(videoTrack);
      videoTrack.onended = () => this.stopScreenShare();
      this.screenStream = screen;
    } catch (err) { this.onError(err); }
  }

  async stopScreenShare() {
    if (!this.screenStream) return;
    this.screenStream.getTracks().forEach((t) => t.stop());
    const camTrack = this.localStream?.getVideoTracks()[0];
    if (camTrack) {
      const sender = this.peerConnection?.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(camTrack);
    }
    this.screenStream = null;
  }

  async hangup() {
    try { this.peerConnection?.close(); } catch {}
    this.peerConnection = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    if (this.room) {
      try { await this.room.leave(); } catch {}
      this.room = null;
    }
  }
}
