(function() {
  'use strict';
  
  if (window.__hiteman_api_interceptor_installed) return;
  window.__hiteman_api_interceptor_installed = true;
  
  console.log('[hiTeman] API interceptor installed');
  
  // Store original methods
  const originalFetch = window.fetch;
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  
  // Intercept Fetch API
  window.fetch = function(...args) {
    const [resource, init = {}] = args;
    const url = typeof resource === 'string' ? resource : resource.url;
    const method = init.method || 'GET';
    const startTime = Date.now();
    
    // Clone arguments to avoid modifying original
    const clonedArgs = [...args];
    
    return originalFetch.apply(this, clonedArgs)
      .then(async response => {
        const endTime = Date.now();
        
        // Clone response to read body without consuming it
        const responseClone = response.clone();
        
        try {
          let responseBody = null;
          let requestBody = null;
          
          // Capture request body
          if (init.body) {
            if (typeof init.body === 'string') {
              try {
                requestBody = JSON.parse(init.body);
              } catch {
                requestBody = init.body;
              }
            } else if (init.body instanceof FormData) {
              requestBody = Object.fromEntries(init.body.entries());
            } else if (init.body instanceof URLSearchParams) {
              requestBody = Object.fromEntries(init.body.entries());
            } else {
              requestBody = init.body;
            }
          }
          
          // Try to capture response body based on content type
          const contentType = response.headers.get('content-type') || '';
          
          if (contentType.includes('application/json')) {
            responseBody = await responseClone.json();
          } else if (contentType.includes('text/')) {
            const text = await responseClone.text();
            if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
              try {
                responseBody = JSON.parse(text);
              } catch {
                responseBody = text;
              }
            } else {
              responseBody = text;
            }
          } else if (contentType.includes('application/x-www-form-urlencoded')) {
            const text = await responseClone.text();
            try {
              responseBody = Object.fromEntries(new URLSearchParams(text));
            } catch {
              responseBody = text;
            }
          } else {
            // For binary data, capture size info
            try {
              const blob = await responseClone.blob();
              responseBody = `[Binary data: ${contentType}, size: ${blob.size} bytes]`;
            } catch {
              responseBody = '[Binary data]';
            }
          }
          
          // LOG THE RESPONSE BODY
          console.log(`[hiTeman] Captured fetch response for ${url}:`, {
            status: response.status,
            contentType: contentType,
            body: responseBody,
            bodyType: typeof responseBody,
            bodySize: typeof responseBody === 'string' ? responseBody.length : 'object'
          });
          
          // Send to extension
          window.postMessage({
            type: 'HITEMAN_API_CAPTURE',
            data: {
              url: url,
              method: method,
              status: response.status,
              statusText: response.statusText,
              request: {
                headers: init.headers ? Object.fromEntries(new Headers(init.headers)) : {},
                body: requestBody
              },
              response: {
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody,
                contentType: contentType
              },
              duration: endTime - startTime,
              timestamp: new Date().toISOString()
            }
          }, '*');
          
        } catch (error) {
          console.error('[hiTeman] Error capturing fetch response:', error);
        }
        
        return response;
      })
      .catch(error => {
        console.error('[hiTeman] Fetch error:', error);
        throw error;
      });
  };
  
  // Intercept XMLHttpRequest
  XMLHttpRequest.prototype.open = function(method, url) {
    this._hitemanRequest = {
      method: method.toUpperCase(),
      url: url,
      headers: {},
      startTime: Date.now()
    };
    return originalXHROpen.apply(this, arguments);
  };
  
  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    if (this._hitemanRequest) {
      this._hitemanRequest.headers[header] = value;
    }
    return originalXHRSetRequestHeader.apply(this, arguments);
  };
  
  XMLHttpRequest.prototype.send = function(body) {
    if (this._hitemanRequest) {
      this._hitemanRequest.body = body;
      
      // Capture request body
      if (body) {
        if (typeof body === 'string') {
          if (body.startsWith('{') || body.startsWith('[')) {
            try {
              this._hitemanRequest.body = JSON.parse(body);
            } catch {
              this._hitemanRequest.body = body;
            }
          } else if (body.includes('=') && body.includes('&')) {
            try {
              this._hitemanRequest.body = Object.fromEntries(new URLSearchParams(body));
            } catch {
              this._hitemanRequest.body = body;
            }
          } else {
            this._hitemanRequest.body = body;
          }
        }
      }
      
      // Add load event listener
      this.addEventListener('load', function() {
        const request = this._hitemanRequest;
        if (!request) return;
        
        const duration = Date.now() - request.startTime;
        
        try {
          let responseBody = null;
          
          // Try to get response body based on responseType
          if (this.responseType === '' || this.responseType === 'text') {
            const responseText = this.responseText;
            if (responseText) {
              if (responseText.trim().startsWith('{') || responseText.trim().startsWith('[')) {
                try {
                  responseBody = JSON.parse(responseText);
                } catch {
                  responseBody = responseText;
                }
              } else {
                responseBody = responseText;
              }
            }
          } else if (this.responseType === 'json' && this.response) {
            responseBody = this.response;
          } else if (this.responseType === 'arraybuffer' || this.responseType === 'blob') {
            responseBody = `[Binary data: ${this.responseType}]`;
          }
          
          // Get response headers
          const responseHeaders = {};
          const headerStr = this.getAllResponseHeaders();
          if (headerStr) {
            const headers = headerStr.trim().split(/[\r\n]+/);
            headers.forEach(line => {
              const parts = line.split(': ');
              const header = parts.shift();
              const value = parts.join(': ');
              if (header) responseHeaders[header] = value;
            });
          }
          
          // LOG THE RESPONSE BODY
          console.log(`[hiTeman] Captured XHR response for ${request.url}:`, {
            status: this.status,
            body: responseBody,
            bodyType: typeof responseBody,
            bodySize: typeof responseBody === 'string' ? responseBody.length : 'object'
          });
          
          // Send to extension
          window.postMessage({
            type: 'HITEMAN_API_CAPTURE',
            data: {
              url: request.url,
              method: request.method,
              status: this.status,
              statusText: this.statusText,
              request: {
                headers: request.headers,
                body: request.body
              },
              response: {
                headers: responseHeaders,
                body: responseBody,
                status: this.status
              },
              duration: duration,
              timestamp: new Date().toISOString()
            }
          }, '*');
          
        } catch (error) {
          console.error('[hiTeman] Error capturing XHR response:', error);
        }
      });
      
      // Add error event listener
      this.addEventListener('error', function() {
        const request = this._hitemanRequest;
        if (!request) return;
        
        window.postMessage({
          type: 'HITEMAN_API_CAPTURE',
          data: {
            url: request.url,
            method: request.method,
            status: 0,
            statusText: 'Network Error',
            request: {
              headers: request.headers,
              body: request.body
            },
            response: {
              body: 'Network Error'
            },
            duration: Date.now() - request.startTime,
            timestamp: new Date().toISOString(),
            error: true
          }
        }, '*');
      });
    }
    
    return originalXHRSend.apply(this, arguments);
  };
  
  console.log('[hiTeman] API interceptor fully installed');
})();