export type VoiceContext = "card-response" | "new-card" | "idle";

// Shared singleton state - persists across all useVoice() calls
const isListening = ref(false);
const transcript = ref("");
const interimTranscript = ref("");
const isSupported = ref(false);
const error = ref<string | null>(null);
const currentContext = ref<VoiceContext>("idle");
let recognition: SpeechRecognition | null = null;
let initialized = false;

export function useVoice() {
  function init() {
    if (initialized) return;
    initialized = true;
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
      let finalText = "";
      let interimText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interimText += result[0].transcript;
        }
      }

      if (finalText) {
        transcript.value += finalText;
      }
      interimTranscript.value = interimText;
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      error.value = event.error;
      isListening.value = false;
    };

    recognition.onend = () => {
      // In continuous mode, restart if still supposed to be listening
      if (isListening.value && recognition) {
        recognition.start();
        return;
      }
      isListening.value = false;
    };
  }

  function setContext(ctx: VoiceContext) {
    currentContext.value = ctx;
  }

  function startListening() {
    if (!recognition) init();
    if (!recognition) return;

    error.value = null;
    transcript.value = "";
    interimTranscript.value = "";
    recognition.start();
    isListening.value = true;
  }

  function stopListening() {
    isListening.value = false;
    interimTranscript.value = "";
    recognition?.stop();
  }

  function toggleListening() {
    if (isListening.value) {
      stopListening();
    } else {
      startListening();
    }
  }

  function clear() {
    transcript.value = "";
    interimTranscript.value = "";
  }

  function cancelDictation() {
    stopListening();
    clear();
    currentContext.value = "idle";
  }

  onMounted(init);

  return {
    isListening,
    transcript,
    interimTranscript,
    isSupported,
    error,
    currentContext,
    setContext,
    startListening,
    stopListening,
    toggleListening,
    cancelDictation,
    clear,
    // Keep old names as aliases for existing VoiceInput component
    start: startListening,
    stop: stopListening,
    toggle: toggleListening,
  };
}
