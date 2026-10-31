// Checks the docket reader in qaforms.js against real scanned text. Run: node tests/docket_test.js
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../qaforms.js'), 'utf8');
const parseDocket = new Function(src.slice(src.indexOf('/* reading a scanned docket'), src.indexOf('window.__parseDocket')) + ';return parseDocket')();
let fails = 0; const ok = (c, l) => { console.log((c ? 'PASS' : 'FAIL') + ': ' + l); if (!c) fails++; };
const real = fs.readFileSync(path.join(__dirname, 'fixtures/docket_ocr.txt'), 'utf8');   // an Alex Fraser docket, as OCR read it
const r = parseDocket(real);
ok(r.docket === '14777629', 'docket number after "Delivery No:"');
ok(r.tonnes === '17.16', 'tonnes from "Net Weight" even when OCR garbles it ("Net Veleit «17.160 Tomes")');
ok(r.rego === 'XB30XX', 'the whole truck rego ("XB3OXX" read with a letter O → XB30XX), not the fleet number');
ok(parseDocket(real.replace(/Net Veleit.*\n/, '')).tonnes === '17.16', 'no net line: Gross − Tare');
ok(parseDocket('Delivery No: 1477 7629').docket === '14777629', 'a docket number read with a space in it');
ok(parseDocket('Net Weight\n25.48').tonnes === '25.48' && parseDocket('Net Weight 25,480 kg').tonnes === '25.48', 'weight on the next line; kilograms → tonnes');
ok(parseDocket('Truck Rego 123 ABC').rego === '123ABC' && !parseDocket('Trailer: Trailer Rego:\nCustomer No: 211296').rego, '"123 ABC" joined; an empty Trailer Rego picks up nothing');
console.log(fails ? `${fails} FAILED` : 'ALL DOCKET TESTS PASSED'); process.exit(fails ? 1 : 0);
