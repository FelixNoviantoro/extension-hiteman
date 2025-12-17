window.__hiteman_recording_active = true;

window.dispatchEvent(new CustomEvent('hiteman:recording', { 
  detail: { isRecording: true } 
}));

console.log('[hiTeman] Setting up recording environment...');