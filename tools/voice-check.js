/* 设备端:语音模块加载、面板开合、解析结果(不依赖麦克风) */
(function () {
  var r = {};
  r.voice = !!(window.Voice && window.Voice.say);
  r.nlu = !!(window.VoiceNLU && window.VoiceNLU.parse);
  r.appctl = !!window.AppCtl;
  r.playerCtrl = !!(typeof Player !== 'undefined' && Player.ctrl && Player.getState);
  r.nativeBridge = !!(window.YSTV && typeof YSTV.startVoice === 'function');

  /* 面板开合 */
  try {
    window.Voice.start();
    var m = document.querySelector('.vc-mask');
    r.panelOpen = !!m;
    r.head = ((m && m.querySelector('.modal-head')) || {}).textContent || '';
    r.heard = ((m && m.querySelector('#vc-heard')) || {}).textContent || '';
    r.intentLine = ((m && m.querySelector('#vc-intent')) || {}).textContent || '';
    r.btnCount = m ? m.querySelectorAll('.vc-b').length : 0;
    r.waveBars = m ? m.querySelectorAll('.vc-wave i').length : 0;
    r.modalRegistered = !!document.querySelector('.modal-mask');
  } catch (e) { r.openErr = String(e); }
  try { window.Voice.close(); } catch (e) {}
  r.panelClosed = !document.querySelector('.vc-mask');

  /* 解析(设备端真实运行时,输入设备端实际使用的 pinyin/esbuild 产物) */
  var cases = ['看庆余年', '下一集', '快进30秒', '音量调到百分之八十', '1.5倍速', '打开设置', '静音', '第5集'];
  r.parse = cases.map(function (t) {
    var x = window.VoiceNLU.parse(t, { player: true });
    return t + ' => ' + x.intent + (x.arg ? ' ' + JSON.stringify(x.arg) : '');
  });

  /* 语音体检:这条是「真机说了没字」时的第一手证据 */
  try {
    r.hasVoiceInfo = !!(window.YSTV && typeof YSTV.voiceInfo === 'function');
    if (r.hasVoiceInfo) r.diag = JSON.parse(YSTV.voiceInfo());
  } catch (e) { r.diagErr = String(e); }
  /* 诊断面板能否渲染 */
  try {
    window.Voice.diag();
    var rowN = document.querySelectorAll('.vc-diag .vc-hrow').length;
    r.diagRows = rowN;
    r.diagHead = (document.querySelector('#vc-heard') || {}).textContent || '';
  } catch (e) { r.diagPanelErr = String(e); }
  try { window.Voice.close(); } catch (e) {}

  return JSON.stringify(r, null, 1);
})();
