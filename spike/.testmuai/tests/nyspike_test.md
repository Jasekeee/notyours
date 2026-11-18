---
mode: testing
max_steps: 50
timeout: 180
target: chrome
headless: true
variables:
  global.site:
    value: http://127.0.0.1:8787/org.html
    secret: false
    syntax: '{{site}}'
    type: global
---

# Session: nyspike

## Step 1
Go to {{site}} and verify the page shows 'Example Domain'
