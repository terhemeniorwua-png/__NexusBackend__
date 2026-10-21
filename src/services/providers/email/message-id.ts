/**
 * Message id helpers.
 *
 * The application builds the SMTP message id itself, so a provider event can
 * be matched to the stored delivery without relying on a provider specific
 * identifier. Brevo reports the message id in angle brackets, while the
 * stored value is the bare id, so both sides are reduced to the same form
 * before they are compared.
 */

export function normalizeMessageId(value: string | undefined | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim().replace(/^</, '').replace(/>$/, '').trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Builds the message id of a delivery.
 *
 * The local part is the id of the delivery row, so a provider event that
 * carries the message id also carries the id of the delivery it belongs to.
 */
export function buildMessageId(deliveryId: string, fromAddress: string): string {
  const domain = extractDomain(fromAddress) ?? 'nexus.local';

  return `${deliveryId}@${domain}`;
}

/**
 * Reads the domain of an address, with or without the display name.
 */
export function extractDomain(address: string): string | undefined {
  const withoutName = address.includes('<')
    ? (address.slice(address.indexOf('<') + 1, address.indexOf('>')) ?? '')
    : address;

  const at = withoutName.lastIndexOf('@');

  if (at < 0 || at === withoutName.length - 1) {
    return undefined;
  }

  return withoutName.slice(at + 1).toLowerCase();
}

/**
 * Reads the local part of a message id, which is the id of the delivery.
 */
export function deliveryIdFromMessageId(messageId: string | undefined): string | undefined {
  const normalized = normalizeMessageId(messageId);

  if (!normalized) {
    return undefined;
  }

  const at = normalized.indexOf('@');

  return at > 0 ? normalized.slice(0, at) : undefined;
}
