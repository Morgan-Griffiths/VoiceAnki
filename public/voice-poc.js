(function () {
  'use strict';

  const els = {
    pttBtn: document.getElementById('pttBtn'),
    recordingStatus: document.getElementById('recordingStatus'),
    recordingTimer: document.getElementById('recordingTimer'),
    audioPreview: document.getElementById('audioPreview'),
    transcribeBtn: document.getElementById('transcribeBtn'),
    languageInput: document.getElementById('languageInput'),
    transcriptBox: document.getElementById('transcriptBox'),
    variantCount: document.getElementById('variantCount'),
    styleSelect: document.getElementById('styleSelect'),
    generateBtn: document.getElementById('generateBtn'),
    cardsList: document.getElementById('cardsList'),
    reasonInput: document.getElementById('reasonInput'),
    saveChoiceBtn: document.getElementById('saveChoiceBtn'),
    statusLog: document.getElementById('statusLog')
  };

  const state = {
    mediaRecorder: null,
    stream: null,
    chunks: [],
    audioBlob: null,
    clipId: null,
    transcript: '',
    cards: [],
    selectedCandidateId: null,
    recordStartedAt: 0,
    timerId: null,
    recordingActive: false
  };

  function log(message, details) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    const detailText =
      details == null ? '' : `\n${typeof details === 'string' ? details : JSON.stringify(details, null, 2)}`;
    els.statusLog.textContent = `${line}${detailText}\n\n${els.statusLog.textContent}`.slice(0, 8000);
  }

  async function postJson(path, payload) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (err) {
      throw new Error(`Bad JSON response: ${text.slice(0, 300)}`);
    }
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
  }

  function setRecordingUi(active) {
    state.recordingActive = active;
    els.pttBtn.classList.toggle('recording', active);
    els.pttBtn.textContent = active ? 'Recording… release to stop' : 'Hold to Record';
    els.recordingStatus.textContent = active ? 'Recording' : 'Idle';
  }

  function startTimer() {
    stopTimer();
    state.recordStartedAt = Date.now();
    state.timerId = window.setInterval(() => {
      const seconds = (Date.now() - state.recordStartedAt) / 1000;
      els.recordingTimer.textContent = `${seconds.toFixed(1)}s`;
    }, 100);
  }

  function stopTimer() {
    if (state.timerId) {
      window.clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  function stopTracks() {
    if (!state.stream) return;
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }

  async function ensureRecorder() {
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      return state.mediaRecorder;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.stream = stream;
    const mimeCandidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      ''
    ];
    const mimeType = mimeCandidates.find((m) => !m || MediaRecorder.isTypeSupported(m)) || '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    state.chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        state.chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      stopTimer();
      setRecordingUi(false);
      stopTracks();
      const blob = new Blob(state.chunks, { type: recorder.mimeType || 'audio/webm' });
      state.audioBlob = blob;
      if (blob.size < 500) {
        log('Clip discarded (too short)');
        els.transcribeBtn.disabled = true;
        els.audioPreview.classList.add('hidden');
        return;
      }
      const url = URL.createObjectURL(blob);
      els.audioPreview.src = url;
      els.audioPreview.classList.remove('hidden');
      els.transcribeBtn.disabled = false;
      log('Recorded clip', { bytes: blob.size, mimeType: blob.type || recorder.mimeType });
    };
    state.mediaRecorder = recorder;
    return recorder;
  }

  async function beginRecording() {
    if (state.recordingActive) return;
    try {
      const recorder = await ensureRecorder();
      if (recorder.state === 'recording') return;
      state.chunks = [];
      recorder.start();
      setRecordingUi(true);
      startTimer();
      log('Recording started');
    } catch (err) {
      log('Recording failed', err.message || String(err));
    }
  }

  function endRecording() {
    const recorder = state.mediaRecorder;
    if (!recorder || recorder.state !== 'recording') return;
    recorder.stop();
    log('Recording stopped');
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(blob);
    });
  }

  async function transcribe() {
    if (!state.audioBlob) {
      log('No audio clip to transcribe');
      return;
    }
    els.transcribeBtn.disabled = true;
    try {
      const audioBase64 = await blobToDataUrl(state.audioBlob);
      log('Uploading audio for transcription...');
      const result = await postJson('/api/voice/transcribe', {
        audioBase64,
        mimeType: state.audioBlob.type || 'audio/webm',
        language: els.languageInput.value.trim() || undefined
      });
      state.clipId = result.clipId || null;
      state.transcript = result.transcript || '';
      els.transcriptBox.value = state.transcript;
      log('Transcription complete', { clipId: state.clipId, model: result.model });
    } catch (err) {
      log('Transcription failed', err.message || String(err));
    } finally {
      els.transcribeBtn.disabled = false;
    }
  }

  function renderCards() {
    els.cardsList.innerHTML = '';
    state.cards.forEach((card) => {
      const item = document.createElement('article');
      item.className = `card-item${state.selectedCandidateId === card.candidate_id ? ' selected' : ''}`;

      const header = document.createElement('header');
      const left = document.createElement('div');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'preferred-card';
      radio.checked = state.selectedCandidateId === card.candidate_id;
      radio.addEventListener('change', () => {
        state.selectedCandidateId = card.candidate_id;
        els.saveChoiceBtn.disabled = false;
        renderCards();
      });
      const title = document.createElement('span');
      title.textContent = ` ${card.candidate_id}`;
      left.appendChild(radio);
      left.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'card-meta';
      meta.textContent = card.card_type;

      header.appendChild(left);
      header.appendChild(meta);
      item.appendChild(header);

      const body = document.createElement('div');
      body.className = 'card-body';

      if (card.card_type === 'cloze') {
        const field = document.createElement('div');
        field.className = 'card-field';
        field.textContent = card.cloze_text || '';
        body.appendChild(field);
      } else {
        const front = document.createElement('div');
        front.className = 'card-field';
        front.textContent = `Front: ${card.front || ''}`;
        const back = document.createElement('div');
        back.className = 'card-field';
        back.textContent = `Back: ${card.back || ''}`;
        body.appendChild(front);
        body.appendChild(back);
      }

      if (card.rationale) {
        const rationale = document.createElement('div');
        rationale.className = 'small';
        rationale.textContent = `Why: ${card.rationale}`;
        body.appendChild(rationale);
      }
      item.appendChild(body);
      els.cardsList.appendChild(item);
    });
  }

  async function generateCards() {
    const transcript = els.transcriptBox.value.trim();
    if (!transcript) {
      log('Transcript is empty');
      return;
    }
    els.generateBtn.disabled = true;
    try {
      const n = Math.max(1, Math.min(5, Number(els.variantCount.value) || 1));
      const style = els.styleSelect.value;
      log('Generating cards...', { n, style });
      const result = await postJson('/api/voice/cards/generate', { transcript, n, style });
      state.transcript = transcript;
      state.cards = Array.isArray(result.cards) ? result.cards : [];
      state.selectedCandidateId = state.cards[0]?.candidate_id || null;
      els.saveChoiceBtn.disabled = !state.selectedCandidateId;
      renderCards();
      log('Card generation complete', { count: state.cards.length, model: result.model });
    } catch (err) {
      log('Card generation failed', err.message || String(err));
    } finally {
      els.generateBtn.disabled = false;
    }
  }

  async function saveChoice() {
    if (!state.selectedCandidateId) {
      log('No card selected');
      return;
    }
    const chosen = state.cards.find((c) => c.candidate_id === state.selectedCandidateId);
    if (!chosen) {
      log('Selected card not found');
      return;
    }
    els.saveChoiceBtn.disabled = true;
    try {
      const result = await postJson('/api/voice/feedback', {
        clipId: state.clipId,
        transcript: els.transcriptBox.value,
        chosenCandidateId: chosen.candidate_id,
        chosenCard: chosen,
        allCandidates: state.cards,
        userReason: els.reasonInput.value.trim()
      });
      log('Preference saved', result);
    } catch (err) {
      log('Save preference failed', err.message || String(err));
      els.saveChoiceBtn.disabled = false;
      return;
    }
    els.saveChoiceBtn.disabled = false;
  }

  function wirePushToTalk() {
    const startEvents = ['pointerdown'];
    const endEvents = ['pointerup', 'pointercancel', 'pointerleave'];

    startEvents.forEach((eventName) => {
      els.pttBtn.addEventListener(eventName, (event) => {
        event.preventDefault();
        beginRecording();
      });
    });
    endEvents.forEach((eventName) => {
      els.pttBtn.addEventListener(eventName, (event) => {
        event.preventDefault();
        endRecording();
      });
    });
  }

  function init() {
    if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
      log('This browser does not support MediaRecorder audio capture');
      els.pttBtn.disabled = true;
      return;
    }
    wirePushToTalk();
    els.transcribeBtn.addEventListener('click', transcribe);
    els.generateBtn.addEventListener('click', generateCards);
    els.saveChoiceBtn.addEventListener('click', saveChoice);
    log('Ready');
  }

  init();
})();
