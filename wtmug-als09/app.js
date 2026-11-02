const CHUNK_SIZE = 16 * 1024; // 16 KB
const App = (() => {
  let peer = null;
  let role = null;
  let isMobile = false;
  let currentFile = null;
  let qrScanner = null;

  // Hoca tarafı
  let studentConnections = new Map(); // connId -> {conn, studentName, status, progress, chunksSent}

  // Öğrenci tarafı
  let teacherConnection = null;
  let receivedChunks = [];
  let receivedSize = 0;
  let totalSize = 0;
  let expectedFileName = '';
  let expectedFileType = '';
  let downloadUrl = null;

  // ---------- Yardımcılar ----------
  function detectMobile() {
    return /Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(navigator.userAgent)
      || (window.innerWidth <= 768 && 'ontouchstart' in window);
  }

  function log(target, message, type = 'info') {
    const el = document.getElementById(`${target}-log`);
    if (!el) return;
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const time = new Date().toLocaleTimeString('tr-TR');
    entry.textContent = `[${time}] ${message}`;
    el.appendChild(entry);
    el.scrollTop = el.scrollHeight;
  }

  function show(elId) { document.getElementById(elId).classList.remove('hidden'); }
  function hide(elId) { document.getElementById(elId).classList.add('hidden'); }

  // ---------- Rol Seçimi ----------
  function selectRole(r) {
    role = r;
    isMobile = detectMobile();
    hide('role-select');

    if (r === 'teacher') {
      show('teacher-mode');
      if (isMobile) {
        alert('Uyarı: Hoca modu masaüstü için tasarlanmıştır. Telefonda da çalışır ancak dosya seçimi zor olabilir.');
      }
    } else {
      show('student-mode');
      // Mobil ise QR butonunu göster
      if (isMobile) show('qr-scan-section');
      log('student', `Cihaz algılandı: ${isMobile ? 'Mobil (QR okutma aktif)' : 'Masaüstü'}`, 'info');
    }
  }

  // ---------- HOCA MODU ----------
  function onTeacherFileSelected(event) {
    const file = event.target.files[0];
    if (!file) return;
    currentFile = file;
    log('teacher', `Dosya seçildi: ${file.name} (${formatSize(file.size)})`, 'success');
    hide('teacher-file-select');
    startTeacherPeer();
  }

  function startTeacherPeer() {
    log('teacher', 'PeerJS başlatılıyor...', 'info');
    peer = new Peer(undefined, {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }
        ]
      }
    });

    peer.on('open', (id) => {
      document.getElementById('teacher-peer-id').textContent = id;
      log('teacher', `Peer ID oluşturuldu: ${id}`, 'success');
      show('teacher-connection');

      // QR Kod oluştur
      const qrContainer = document.getElementById('qrcode');
      qrContainer.innerHTML = '';
      new QRCode(qrContainer, {
        text: id,
        width: 200,
        height: 200,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
      log('teacher', 'QR kod oluşturuldu', 'info');
      log('teacher', 'Öğrenciler bağlanmayı bekliyor...', 'warn');
    });

    peer.on('connection', (conn) => {
      handleStudentConnection(conn);
    });

    peer.on('error', (err) => {
      log('teacher', `Peer hatası: ${err.type} - ${err.message}`, 'error');
    });
  }

  function handleStudentConnection(conn) {
    const studentName = `Öğrenci-${conn.peer.slice(0, 6)}`;
    log('teacher', `Yeni öğrenci bağlandı: ${conn.peer}`, 'success');

    const record = {
      conn,
      name: studentName,
      status: 'connected',
      progress: 0,
      peerId: conn.peer
    };
    studentConnections.set(conn.peer, record);
    updateStudentUI();
    updateStudentCount();

    conn.on('open', () => {
      log('teacher', `${studentName} bağlantısı açık, dosya gönderimi başlıyor`, 'info');
      record.status = 'sending';
      updateStudentUI();
      sendFileToStudent(conn, record);
    });

    conn.on('data', (data) => {
      if (data && data.type === 'request-file') {
        // Öğrenci hazır, meta bilgilerini gönder
      }
    });

    conn.on('close', () => {
      log('teacher', `${studentName} bağlantısı kapandı`, 'warn');
      record.status = 'closed';
      updateStudentUI();
    });

    conn.on('error', (err) => {
      log('teacher', `${studentName} hatası: ${err}`, 'error');
      record.status = 'error';
      updateStudentUI();
    });
  }

  function sendFileToStudent(conn, record) {
    if (!currentFile) return;
    const file = currentFile;

    // 1) Önce meta bilgilerini gönder
    conn.send({
      type: 'meta',
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || 'application/octet-stream'
    });

    // 2) Parçalara bölerek gönder
    let offset = 0;
    let chunkIndex = 0;

    const reader = new FileReader();

    function sendNextChunk() {
      if (offset >= file.size) {
        conn.send({ type: 'transfer-complete' });
        record.status = 'done';
        record.progress = 100;
        log('teacher', `✅ ${record.name} için transfer tamamlandı (${chunkIndex} parça)`, 'success');
        updateStudentUI();
        return;
      }

      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);

      reader.onload = (e) => {
        const buffer = e.target.result;
        conn.send({
          type: 'chunk',
          index: chunkIndex,
          data: buffer
        });

        offset += buffer.byteLength;
        chunkIndex++;
        record.progress = Math.min(100, Math.round((offset / file.size) * 100));

        if (chunkIndex % 20 === 0 || offset >= file.size) {
          log('teacher', `${record.name}: %${record.progress} (${formatSize(offset)}/${formatSize(file.size)})`, 'info');
          updateStudentUI();
        }

        // Backpressure: DataChannel buffer doluysa bekle
        if (conn.dataChannel && conn.dataChannel.bufferedAmount > 1024 * 1024) {
          setTimeout(sendNextChunk, 50);
        } else {
          setTimeout(sendNextChunk, 0);
        }
      };

      reader.onerror = (err) => {
        log('teacher', `${record.name} okuma hatası: ${err}`, 'error');
        record.status = 'error';
        updateStudentUI();
      };
    }

    log('teacher', `${record.name} için gönderim başladı: ${file.name}`, 'info');
    sendNextChunk();
  }

  function updateStudentCount() {
    document.getElementById('student-count').textContent = studentConnections.size;
  }

  function updateStudentUI() {
    const card = document.getElementById('teacher-students-card');
    const list = document.getElementById('student-list');
    if (studentConnections.size === 0) {
      card.style.display = 'none';
      return;
    }
    card.style.display = 'block';
    list.innerHTML = '';

    studentConnections.forEach((rec, peerId) => {
      const div = document.createElement('div');
      div.className = 'student-item';
      const statusText = {
        connected: '🔗 Bağlı',
        sending: '📤 Gönderiliyor',
        done: '✅ Tamamlandı',
        closed: '❌ Kapandı',
        error: '⚠️ Hata'
      }[rec.status] || rec.status;

      div.innerHTML = `
        <div class="name">${rec.name} <span class="status-badge ${rec.status}">${statusText}</span></div>
        <div style="font-size:0.8rem;color:#94a3b8;margin-bottom:6px;">${peerId}</div>
        <div class="progress-bar" style="height:18px;">
          <div class="progress-fill" style="width:${rec.progress}%;font-size:0.7rem;">${rec.progress}%</div>
        </div>
      `;
      list.appendChild(div);
    });
  }

  // ---------- ÖĞRENCİ MODU ----------
  function connectToTeacher() {
    const teacherId = document.getElementById('teacher-id-input').value.trim();
    if (!teacherId) {
      alert('Lütfen hocanın ID\'sini girin.');
      return;
    }

    log('student', `Hocaya bağlanılıyor: ${teacherId}`, 'info');
    show('student-status-card');
    document.getElementById('student-status-text').textContent = 'Bağlanılıyor...';

    if (peer) peer.destroy();
    peer = new Peer(undefined, {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }
        ]
      }
    });

    peer.on('open', () => {
      log('student', 'Peer hazır, bağlantı kuruluyor...', 'info');
      teacherConnection = peer.connect(teacherId, { reliable: true });
      setupStudentConnection();
    });

    peer.on('error', (err) => {
      log('student', `Hata: ${err.type} - ${err.message}`, 'error');
      document.getElementById('student-status-text').textContent = `Hata: ${err.type}`;
    });
  }

  function setupStudentConnection() {
    teacherConnection.on('open', () => {
      log('student', '✅ Hocaya bağlandı!', 'success');
      document.getElementById('student-status-text').textContent = 'Bağlandı, dosya bekleniyor...';
      teacherConnection.send({ type: 'request-file' });
    });

    teacherConnection.on('data', (data) => {
      handleIncomingData(data);
    });

    teacherConnection.on('close', () => {
      log('student', 'Bağlantı kapandı', 'warn');
      document.getElementById('student-status-text').textContent = 'Bağlantı kapandı';
    });

    teacherConnection.on('error', (err) => {
      log('student', `Bağlantı hatası: ${err}`, 'error');
    });
  }

  function handleIncomingData(data) {
    if (!data || !data.type) return;

    if (data.type === 'meta') {
      expectedFileName = data.fileName;
      expectedFileType = data.fileType;
      totalSize = data.fileSize;
      receivedChunks = [];
      receivedSize = 0;
      log('student', `Dosya bilgisi alındı: ${data.fileName} (${formatSize(data.fileSize)})`, 'info');
      document.getElementById('student-status-text').textContent = `Alınıyor: ${data.fileName}`;
    }

    else if (data.type === 'chunk') {
      receivedChunks.push(data.data);
      receivedSize += data.data.byteLength;
      const percent = Math.min(100, Math.round((receivedSize / totalSize) * 100));
      const fill = document.getElementById('student-progress');
      fill.style.width = percent + '%';
      fill.textContent = percent + '%';

      if (data.index % 20 === 0) {
        log('student', `Alındı: %${percent} (${formatSize(receivedSize)}/${formatSize(totalSize)})`, 'info');
      }
    }

    else if (data.type === 'transfer-complete') {
      log('student', '✅ Transfer tamamlandı!', 'success');
      const blob = new Blob(receivedChunks, { type: expectedFileType });
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(blob);

      document.getElementById('student-status-text').textContent = `Tamamlandı: ${expectedFileName}`;
      document.getElementById('student-progress').style.width = '100%';
      document.getElementById('student-progress').textContent = '100%';

      const btn = document.getElementById('download-btn');
      btn.onclick = () => {
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = expectedFileName || 'dosya';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        log('student', 'Dosya indirildi', 'success');
      };
      show('download-section');
    }
  }

  // ---------- QR TARAYICI ----------
  function toggleQrScanner() {
    const readerDiv = document.getElementById('qr-reader');
    if (!qrScanner) {
      readerDiv.classList.remove('hidden');
      qrScanner = new Html5Qrcode('qr-reader');
      qrScanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: 250 },
        (decodedText) => {
          log('student', `QR okundu: ${decodedText}`, 'success');
          document.getElementById('teacher-id-input').value = decodedText;
          stopQrScanner();
          connectToTeacher();
        },
        (err) => { /* sessiz */ }
      ).catch((err) => {
        log('student', `Kamera hatası: ${err}`, 'error');
        readerDiv.classList.add('hidden');
        qrScanner = null;
      });
    } else {
      stopQrScanner();
    }
  }

  function stopQrScanner() {
    if (qrScanner) {
      qrScanner.stop().then(() => qrScanner.clear()).catch(() => {});
      qrScanner = null;
      document.getElementById('qr-reader').classList.add('hidden');
    }
  }

  // ---------- Yardımcı ----------
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // ---------- Service Worker ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        console.log('SW registered:', reg.scope);
      }).catch((err) => console.error('SW error:', err));
    });
  }

  return {
    selectRole,
    onTeacherFileSelected,
    connectToTeacher,
    toggleQrScanner
  };
})();