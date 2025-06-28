/**
 * Cloudflare Email Worker - Forwards emails to ntfy notifications
 * Handles MIME parsing, encoding detection, and error handling
 */

class EmailProcessor {
  constructor(env) {
    this.env = env;
    this.validateEnvironment();
  }

  /**
   * Validates required environment variables
   */
  validateEnvironment() {
    if (!this.env.NTFY_SERVER) {
      throw new Error('NTFY_SERVER environment variable is required');
    }
  }

  /**
   * Decodes quoted-printable encoded text
   * @param {string} input - Quoted-printable encoded string
   * @returns {string} Decoded string
   */
  decodeQuotedPrintable(input) {
    if (!input) return '';
    
    return input
      .replace(/=\r?\n/g, '') // Remove soft line breaks
      .replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => 
        String.fromCharCode(parseInt(hex, 16))
      );
  }

  /**
   * Decodes base64 encoded text with error handling
   * @param {string} input - Base64 encoded string
   * @returns {string} Decoded string
   */
  decodeBase64(input) {
    if (!input) return '';
    
    try {
      return atob(input.replace(/\s/g, ''));
    } catch (error) {
      console.warn('Failed to decode base64:', error);
      return input; // Return original if decode fails
    }
  }

  /**
   * Extracts plain text content from MIME email
   * @param {string} raw - Raw email content
   * @returns {string} Extracted plain text
   */
  extractPlainText(raw) {
    if (!raw) return '';

    // Find MIME boundary
    const boundaryMatch = raw.match(/boundary="?([^";\r\n]+)"?/i);
    
    if (!boundaryMatch) {
      return this.extractSimpleEmail(raw);
    }

    const boundary = boundaryMatch[1];
    const parts = raw.split(`--${boundary}`);

    // Process each MIME part
    for (const part of parts) {
      if (!part.includes('Content-Type: text/plain')) continue;

      const body = this.extractPartBody(part);
      if (body) return body;
    }

    // Fallback to simple extraction
    return this.extractSimpleEmail(raw);
  }

  /**
   * Extracts body from a simple (non-MIME) email
   * @param {string} raw - Raw email content
   * @returns {string} Email body
   */
  extractSimpleEmail(raw) {
    const headerEnd = raw.indexOf('\r\n\r\n');
    return headerEnd !== -1 
      ? raw.slice(headerEnd + 4).trim() 
      : raw.trim();
  }

  /**
   * Extracts and decodes body from a MIME part
   * @param {string} part - MIME part content
   * @returns {string|null} Decoded body or null if extraction fails
   */
  extractPartBody(part) {
    const bodyStart = part.indexOf('\r\n\r\n');
    if (bodyStart === -1) return null;
    
    // Extract encoding type
    const encodingMatch = part.match(/Content-Transfer-Encoding:\s*(\S+)/i);
    const encoding = encodingMatch ? encodingMatch[1].toLowerCase() : '7bit';
    
    // Extract raw body
    let body = part.slice(bodyStart + 4).trim();
    body = body.replace(/--$/, '').trim(); // Remove trailing boundary markers
    
    if (!body) return null;

    // Decode based on encoding
    switch (encoding) {
      case 'quoted-printable':
        return this.decodeQuotedPrintable(body);
      case 'base64':
        return this.decodeBase64(body);
      default:
        return body;
    }
  }

  /**
   * Cleans and formats email body text
   * @param {string} text - Raw email body
   * @returns {string} Cleaned and formatted text
   */
  cleanBodyText(text) {
    if (!text) return '';

    return text
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim()
      .split('\n')
      .filter(line => !line.trim().startsWith('>')) // Remove quoted replies
      .join('\n')
      .trim();
  }

  /**
   * Truncates text with ellipsis if too long
   * @param {string} text - Text to truncate
   * @param {number} maxLength - Maximum length (default: 1000)
   * @returns {string} Truncated text
   */
  truncateText(text, maxLength = 1000) {
    if (!text || text.length <= maxLength) return text;
    
    return text.slice(0, maxLength) + '\n\n*...truncated*';
  }

  /**
   * Generates ntfy topic from email domain
   * @param {string} email - Email address
   * @returns {string} Topic name
   */
  generateTopic(email) {
    if (!email || !email.includes('@')) return 'unknown';
    
    const domain = email.split('@')[1];
    return domain ? domain.replace(/\./g, '-') : 'unknown';
  }

  /**
   * Sanitizes header values for safe display
   * @param {string} value - Header value
   * @returns {string} Sanitized value
   */
  sanitizeHeader(value) {
    if (!value) return '';
    
    return value
      .replace(/[\r\n]/g, ' ') // Remove line breaks
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  /**
   * Builds markdown formatted notification payload
   * @param {Object} emailData - Email data object
   * @returns {string} Markdown formatted payload
   */
  buildMarkdownPayload(emailData) {
    const { from, to, subject, date, body } = emailData;
    
    return `
**Date:** ${this.sanitizeHeader(date)}

**From:** ${this.sanitizeHeader(from)}  
**To:** ${this.sanitizeHeader(to)}  
**Subject:** ${this.sanitizeHeader(subject)}  

---

${body}
`.trim();
  }

  /**
   * Sends notification to ntfy server
   * @param {string} topic - ntfy topic
   * @param {string} payload - Message payload
   * @param {string} subject - Email subject for title
   * @param {string} to - Recipient email for tags
   */
  async sendNotification(topic, payload, subject, to) {
    const ntfyServer = this.env.NTFY_SERVER.replace(/\/$/, ''); // Remove trailing slash
    const url = `${ntfyServer}/${topic}`;
    
    const headers = {
      'Title': `Email: ${this.sanitizeHeader(subject)}`,
      'Priority': '4',
      'Tags': `email,${this.sanitizeHeader(to)}`,
      'Markdown': 'yes'
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: payload
      });

      if (!response.ok) {
        console.error(`ntfy request failed: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error('Failed to send ntfy notification:', error);
      throw error;
    }
  }

  /**
   * Processes incoming email message
   * @param {Object} message - Cloudflare email message object
   */
  async processEmail(message) {
    try {
      // Extract email metadata
      const to = message.to || '';
      const from = message.headers.get('from') || message.from || '(unknown sender)';
      const subject = message.headers.get('subject') || '(no subject)';
      const date = message.headers.get('date') || new Date().toISOString();

      // Extract and process email body
      const raw = await new Response(message.raw).text();
      let bodyText = this.extractPlainText(raw);
      bodyText = this.cleanBodyText(bodyText);
      const truncatedBody = this.truncateText(bodyText);

      // Build notification
      const emailData = { from, to, subject, date, body: truncatedBody };
      const payload = this.buildMarkdownPayload(emailData);
      const topic = this.generateTopic(to);

      // Send notification
      await this.sendNotification(topic, payload, subject, to);
      
      console.log(`Email notification sent for: ${subject}`);
    } catch (error) {
      console.error('Email processing failed:', error);
      throw error;
    }
  }
}

/**
 * Main Cloudflare Worker export
 */
export default {
  async email(message, env, ctx) {
    try {
      const processor = new EmailProcessor(env);
      await processor.processEmail(message);
    } catch (error) {
      console.error('Worker email handler failed:', error);
      // Don't re-throw to prevent Cloudflare retries for permanent failures
    }
  }
};
