// OMP's streamed msg-N ids belong to one RPC connection. The message
// timestamp survives both get_messages_page and reopening the journal.
function turnMessageKey(message) {
  if (!Number.isSafeInteger(message?.timestamp) || message.timestamp <= 0) return undefined;
  if (message.role === 'user') return 'user-' + message.timestamp;
  if (message.role === 'custom' && message.customType === 'skill-prompt'
      && message.attribution === 'user' && message.display !== false) return 'skill-' + message.timestamp;
}

module.exports = {turnMessageKey};
