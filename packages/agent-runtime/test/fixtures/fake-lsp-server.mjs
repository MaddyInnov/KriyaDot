// SPDX-License-Identifier: Apache-2.0
// Fake language server for LSP tests (CA-9): a tiny dependency-free
// JSON-RPC-over-stdio server. It speaks just enough LSP for LspManager:
//   initialize / shutdown / exit
//   textDocument/didOpen + didChange  → publishDiagnostics: any line
//     containing "lsp_error" yields an Error diagnostic, any line
//     containing "lsp_warn" yields a Warning diagnostic.
//   textDocument/definition / hover / references → canned results.
// No network, no real language servers — tests stay hermetic.

let buffer = Buffer.alloc(0);
const documents = new Map();

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'), body]));
}

function publishDiagnostics(uri) {
  const text = documents.get(uri) ?? '';
  const diagnostics = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes('lsp_error')) {
      diagnostics.push({
        range: { start: { line: i, character: 0 }, end: { line: i, character: line.length } },
        severity: 1,
        message: `fake error on line ${i + 1}`,
        source: 'fake-lsp',
      });
    }
    if (line.includes('lsp_warn')) {
      diagnostics.push({
        range: { start: { line: i, character: 0 }, end: { line: i, character: line.length } },
        severity: 2,
        message: `fake warning on line ${i + 1}`,
        source: 'fake-lsp',
      });
    }
  });
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
}

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id, result: { capabilities: { textDocumentSync: 1 } } });
      break;
    case 'initialized':
      break;
    case 'textDocument/didOpen':
      documents.set(params.textDocument.uri, params.textDocument.text);
      publishDiagnostics(params.textDocument.uri);
      break;
    case 'textDocument/didChange':
      documents.set(params.textDocument.uri, params.contentChanges[0].text);
      publishDiagnostics(params.textDocument.uri);
      break;
    case 'textDocument/didClose':
      documents.delete(params.textDocument.uri);
      break;
    case 'textDocument/definition':
      send({
        jsonrpc: '2.0',
        id,
        result: [{ uri: params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }],
      });
      break;
    case 'textDocument/hover':
      send({ jsonrpc: '2.0', id, result: { contents: { kind: 'plaintext', value: 'fake hover text' } } });
      break;
    case 'textDocument/references':
      send({
        jsonrpc: '2.0',
        id,
        result: [
          { uri: params.textDocument.uri, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } } },
          { uri: params.textDocument.uri, range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } } },
        ],
      });
      break;
    case 'shutdown':
      send({ jsonrpc: '2.0', id, result: null });
      break;
    case 'exit':
      process.exit(0);
      break;
    default:
      if (typeof id === 'number') send({ jsonrpc: '2.0', id, result: null });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) break;
    const len = Number(m[1]);
    const total = headerEnd + 4 + len;
    if (buffer.length < total) break;
    const body = buffer.subarray(headerEnd + 4, total).toString('utf8');
    buffer = buffer.subarray(total);
    try {
      handle(JSON.parse(body));
    } catch {
      // ignore malformed frames
    }
  }
});
