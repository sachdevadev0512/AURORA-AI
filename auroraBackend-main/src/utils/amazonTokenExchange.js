const axios = require('axios');

/**
 * Amazon OAuth Token Exchange Utility
 * Handles server-to-server communication with Amazon OAuth endpoints
 */
class AmazonTokenExchange {
  constructor() {
    this.clientId = process.env.AMAZON_CLIENT_ID;
    this.clientSecret = process.env.AMAZON_CLIENT_SECRET;
    this.redirectUri = process.env.AMAZON_REDIRECT_URI;

    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      throw new Error('Missing Amazon OAuth configuration. Please check AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET, and AMAZON_REDIRECT_URI in .env');
    }
  }

  /**
   * Exchange authorization code for access and refresh tokens
   * @param {string} authorizationCode - Code received from Amazon OAuth callback
   * @returns {Promise<Object>} Token response containing access_token, refresh_token, etc.
   */
  async exchangeCodeForTokens(authorizationCode) {
    try {
      const response = await axios.post('https://api.amazon.com/auth/o2/token', {
        grant_type: 'authorization_code',
        code: authorizationCode,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
      }, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 30000, // 30 second timeout
      });

      return {
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token,
        token_type: response.data.token_type,
        expires_in: response.data.expires_in,
        selling_partner_id: response.data.selling_partner_id,
      };
    } catch (error) {
      console.error('Token exchange error:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      });

      if (error.response?.status === 400) {
        throw new Error('Invalid authorization code or client credentials');
      } else if (error.response?.status === 401) {
        throw new Error('Unauthorized - check client credentials');
      } else {
        throw new Error('Failed to exchange authorization code for tokens');
      }
    }
  }

  /**
   * Refresh an access token using refresh token
   * @param {string} refreshToken - The refresh token
   * @returns {Promise<Object>} New token response
   */
  async refreshAccessToken(refreshToken) {
    try {
      const response = await axios.post('https://api.amazon.com/auth/o2/token', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 30000,
      });

      return {
        access_token: response.data.access_token,
        token_type: response.data.token_type,
        expires_in: response.data.expires_in,
      };
    } catch (error) {
      console.error('Token refresh error:', error.response?.data || error.message);

      if (error.response?.status === 400) {
        throw new Error('Invalid refresh token');
      } else {
        throw new Error('Failed to refresh access token');
      }
    }
  }

  /**
   * Validate if a refresh token is still valid
   * @param {string} refreshToken - The refresh token to validate
   * @returns {Promise<boolean>} True if valid, false if expired/revoked
   */
  async validateRefreshToken(refreshToken) {
    try {
      // Try to refresh the token - if it works, token is valid
      await this.refreshAccessToken(refreshToken);
      return true;
    } catch (error) {
      // If refresh fails, token is likely invalid
      return false;
    }
  }

  /**
   * Revoke a refresh token (logout/disconnect)
   * @param {string} refreshToken - The refresh token to revoke
   * @returns {Promise<boolean>} True if successfully revoked
   */
  async revokeRefreshToken(refreshToken) {
    try {
      await axios.post('https://api.amazon.com/auth/o2/revoke', {
        token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      });

      return true;
    } catch (error) {
      console.error('Token revocation error:', error.response?.data || error.message);
      // Even if revocation fails on Amazon's side, we should clear it locally
      return false;
    }
  }
}

module.exports = AmazonTokenExchange;