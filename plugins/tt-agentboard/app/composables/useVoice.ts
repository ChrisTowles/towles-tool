export function useVoice() {
  const isListening = ref(false);
  const transcript = ref("");
  const isSupported = ref(false);
  const error = ref<string | null>(null);

  let recognition: SpeechRecognition | null = null;

  function init() {
    const SpeechRecognition = window.SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      isSupported.value = false;
      return;
    }

    isSupported.value = true;
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        }
      }

      if (finalTranscript) {
        transcript.value += finalTranscript;
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      error.value = event.error;
      isListening.value = false;
    };

    recognition.onend = () => {
      isListening.value = false;
    };
  }

  function start() {
    if (!recognition) init();
    if (!recognition) return;

    error.value = null;
    transcript.value = "";
    recognition.start();
    isListening.value = true;
  }

  function stop() {
    recognition?.stop();
    isListening.value = false;
  }

  function toggle() {
    if (isListening.value) {
      stop();
    } else {
      start();
    }
  }

  function clear() {
    transcript.value = "";
  }

  onMounted(init);

  return {
    isListening,
    transcript,
    isSupported,
    error,
    start,
    stop,
    toggle,
    clear,
  };
}
