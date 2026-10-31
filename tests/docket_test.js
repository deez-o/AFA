// Checks the docket reader in qaforms.js against real scanned text. Run: node tests/docket_test.js
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../qaforms.js'), 'utf8');
const { parseDocket, fillDocketGap } = new Function(src.slice(src.indexOf('/* reading a scanned docket'), src.indexOf('function LayingEditor')).replace(/window\.__parseDocket=parseDocket;/, '').replace(/^const (fmt2|layRow|LAY_NEED|layMissing|rowDone)=.*$/mg, '') + ';return {parseDocket, fillDocketGap}')();
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
// a third docket (147769241, net 12.880 t): the dead strip cuts the 6, and the phone's reading loses the last digit too
const r3 = parseDocket(fs.readFileSync(path.join(__dirname, 'fixtures/docket_ocr_3.txt'), 'utf8'));
ok(r3.tonnes === '12.88', 'docket 3: tonnes read (12.880)');
ok(r3.docket !== '147769241' && fillDocketGap(r3.docket, ['147769000']).odd === true, 'docket 3: the number reads badly ("1477324"), so it is marked to check, not accepted');
ok(fillDocketGap('14779241', ['147769000']).docket === '147769241', 'docket 3 with only the printer’s gap: filled from an earlier load that night (147769241)');
// the printer's dead strip: one digit of the delivery number isn't printed
let g = fillDocketGap('14777629', ['147757000', '147757311']);
ok(g.docket === '147757629' && g.guess.digit === '5', 'a digit short: filled from an earlier load sharing the start (14777629 → 147757629), flagged to check');
g = fillDocketGap('14773012', []);
ok(g.docket === '1477?3012' && g.guess.digit === null, 'nothing to go on: a "?" where the gap falls, to type in');
ok(fillDocketGap('14773012', ['147763999'], parseDocket('Delivery No: 1477 3012').docketGapAt).docket === '147763012', 'a gap read as a space: that is where the digit goes (filled from an earlier load)');
ok(!fillDocketGap('147757629', ['147757000']).guess, 'a full docket number is left alone');
ok(!fillDocketGap('1477324', ['147757000']).guess && fillDocketGap('1477324', ['147757000']).odd, 'a number that read badly (two short) isn’t guessed at, but is marked to check');
console.log(fails ? `${fails} FAILED` : 'ALL DOCKET TESTS PASSED'); process.exit(fails ? 1 : 0);
