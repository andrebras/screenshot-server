const os = require('os');
const { addError } = require('./appsignal');

// One JSON object per line on stderr, so the log pipeline indexes level and metadata as fields.
// pod is the hostname, as in the AppSignal metric tags.
const write = (level, message, metadata) => {
  const line = {timestamp: new Date().toISOString(), level, message, pod: os.hostname(), ...metadata};
  process.stderr.write(`${JSON.stringify(line)}\n`);
};

const logger = {
  info: (message, metadata = {}) => {
    write('info', message, metadata);
  },

  warn: (message, metadata = {}) => {
    write('warn', message, metadata);
  },

  error: (messageOrError, metadata = {}) => {
    if (messageOrError instanceof Error) {
      const err = messageOrError;
      const message = err.message || String(err);
      write('error', message, metadata);
      addError(err);
    } else {
      write('error', messageOrError, metadata);
    }
  },

  debug: (message, metadata = {}) => {
    write('debug', message, metadata);
  }
};

module.exports = logger;
