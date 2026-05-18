const fs = require('fs');
let c = fs.readFileSync('/app/nullsafe-discord/ecosystem.config.js', 'utf8');

c = c.replace(
  'MISTRAL_API_KEY:       process.env.MISTRAL_API_KEY,',
  'MISTRAL_API_KEY:       process.env.MISTRAL_API_KEY,\n  MISTRAL_TTS_MODEL:     process.env.MISTRAL_TTS_MODEL,\n  MISTRAL_STT_MODEL:     process.env.MISTRAL_STT_MODEL,'
);

fs.writeFileSync('/app/nullsafe-discord/ecosystem.config.js', c);
console.log('patched');
