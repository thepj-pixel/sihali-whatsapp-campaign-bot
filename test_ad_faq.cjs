const a = require('./ad_faq.js'); let ok = 0, bad = 0; const t = (c, m) => c ? ok++ : (bad++, console.log('FAIL', m));
t(a.isAdFaq('मेरी वोटर पर्ची कैसे मिलेगी?'), 'exact'); t(a.isAdFaq('  मेरी वोटर  पर्ची कैसे मिलेगी '), 'spaces/no ?');
t(a.isAdFaq('बाबा अभय सिंह जी के बारे में बताइए'), 'q1'); t(a.isAdFaq('मतदान कब है और मुहर कैसे लगानी है?'), 'q3');
t(!a.isAdFaq('राम राम जी'), 'greeting'); t(!a.isAdFaq('मेरी वोटर पर्ची राजेश देवी'), 'name'); t(!a.isAdFaq(''), 'empty');
(async () => {
  const k = 'sim|1@s.whatsapp.net', t0 = Date.now();
  setTimeout(() => a.noteForeignOutgoing(k), 300);
  t(await a.answeredElsewhere(k, t0, 2000, 100) === true, 'seen');
  t(await a.answeredElsewhere('sim|2', Date.now(), 600, 100) === false, 'not seen -> bot answers');
  a.noteForeignOutgoing('sim|3', Date.now() - 60000);
  t(await a.answeredElsewhere('sim|3', Date.now(), 300, 100) === false, 'old foreign msg ignored');
  a.noteBotSend('sim|4'); a.noteForeignOutgoing('sim|4');
  t(await a.answeredElsewhere('sim|4', Date.now() - 100, 300, 100) === false, 'bot own echo ignored');
  console.log(`test:adfaq ${ok}/${ok + bad}`); process.exit(bad ? 1 : 0);
})();
