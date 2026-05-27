#!/bin/sh
set -eu

LISTEN_PORT="${PORT:-8080}"
API_PORT="${API_PORT:-3000}"

cat > /etc/nginx/conf.d/railway.conf <<'NGINX'
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}

server {
  listen __LISTEN_PORT__;
  server_name _;
  root /app/web/dist;
  index index.html;
  client_max_body_size 10m;

  location = /health {
    proxy_pass http://127.0.0.1:__API_PORT__;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:__API_PORT__;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /collaboration {
    proxy_pass http://127.0.0.1:__API_PORT__;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
  }

  location /events {
    proxy_pass http://127.0.0.1:__API_PORT__;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
  }

  location /assets/ {
    try_files $uri =404;
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
NGINX

sed -i "s/__LISTEN_PORT__/${LISTEN_PORT}/g; s/__API_PORT__/${API_PORT}/g" /etc/nginx/conf.d/railway.conf

cd /app/api
node dist/db/migrate.js
PORT="${API_PORT}" node dist/index.js &

exec nginx -g 'daemon off;'
