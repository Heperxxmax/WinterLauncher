const https = require('https');
const http = require('http');
const fs = require('fs');

function downloadFile(url, destPath, onProgress, onRequest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;

    const request = (targetUrl, redirectsLeft) => {
      const req = client.get(targetUrl, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          res.resume();
          request(res.headers.location, redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }

        const total = parseInt(res.headers['content-length'], 10) || 0;
        let received = 0;
        const file = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress(total ? received / total : 0, received, total);
        });

        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(destPath)));
        file.on('error', (err) => {
          fs.unlink(destPath, () => reject(err));
        });
      });
      req.on('error', reject);
      if (onRequest) onRequest(req);
    };

    request(url, 5);
  });
}

module.exports = { downloadFile };
