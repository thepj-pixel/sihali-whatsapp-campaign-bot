# Reply Brain — before / after (40 messages, local engine, no LLM keys)

"Before" = commit 5dc064e local fallback (`getFastLocalAnswer`, what voters got when the LLM was down or keys missing). "After" = `reply_brain.js` grounded reply.

### 1. "राम राम"
- **Before:** राम राम भैया! 🙏 बाबा अभय सिंह (मोटी आंगली वाले बाबा) जनसंपर्क। वोटर पर्ची देखने के लिए अपना शुभ नाम लिखकर भेजें, या गाँव के विकास कार्यों पर चर्चा करें! 🚩
- **After** _(intent: greeting, stage: unknown)_: राम राम जी! 🙏 घर-परिवार में सब कुशल-मंगल? आपके मोहल्ले में इस बार चुनाव का क्या माहौल है?

### 2. "Ram ram bhai"
- **Before:** Ram Ram bhaiya! 🙏 Baba Abhay Singh (Moti Aangli Wale Baba) Jansampark. Voter parchi dekhne ke liye apna naam likh kar bhejein, ya vikas karyon par charcha karein! 🚩
- **After** _(intent: greeting, stage: unknown)_: Ram Ram ji! 🙏 Ghar-parivar me sab kushal-mangal? Aapke mohalle me is baar chunav ka kya mahaul hai?

### 3. "kaise ho"
- **Before:** Ram Ram bhaiya! 🙏 Baba Abhay Singh ke aashirwad aur aap sabhi ke pyar se sab badhiya hai. Aap batao bhaiya, ghar-parivar me sab kushal mangal? Apne mohalle aur ward me is baar kya mahol lag raha hai? 😊🚩
- **After** _(intent: greeting, stage: unknown)_: Ram Ram ji! 🙏 Ghar-parivar me sab kushal-mangal? Aapke mohalle me is baar chunav ka kya mahaul hai?

### 4. "Baba Abhay Singh kaun hai?"
- **Before:** Ram Ram bhaiya! 🙏 Baba Abhay Singh (Moti Aangli Wale Baba) Sihali Khurd, Sihali Kalan va Hadahedi teeno gaon ke sarvamanya va nishwarth jan-sevak hain. • 40 saalon se bina kisi lalach ya pad ke har gaon wale ke sukh-dukh me khunta gaad kar sath khade rahe hain. • Niji zameen daan dekar up-swasthya kendra banwaya aur JJM meetha paani dilwaya. Is baar teeno gaon ke samman va vikas ke liye sarpanch pad ke candidate hain! 🚩
- **After** _(intent: about_baba, stage: undecided)_: Abhay Singh ji (Moti Aangli wale) Gram Panchayat Sihali Khurd se Sarpanch pratyashi hain—40 saal se gaon ki seva aur bhaichare me lage hain. Apni pushtaini zameen daan karke gaon ka up-swasthya kendra banwaya. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na?

### 5. "अभय सिंह जी के बारे में बताओ"
- **Before:** राम राम भैया! 🙏 बाबा अभय सिंह (मोटी आंगली वाले बाबा) जनसंपर्क। वोटर पर्ची देखने के लिए अपना शुभ नाम लिखकर भेजें, या गाँव के विकास कार्यों पर चर्चा करें! 🚩
- **After** _(intent: about_baba, stage: undecided)_: अभय सिंह जी (मोटी आंगली वाले) ग्राम पंचायत सिहाली खुर्द से सरपंच प्रत्याशी हैं—40 साल से गाँव की सेवा और भाईचारे में लगे हैं। अपनी पुश्तैनी ज़मीन दान देकर गाँव का उप-स्वास्थ्य केंद्र बनवाया। बस इतना सोचिएगा—40 साल से गाँव के सुख-दुख में कौन साथ खड़ा रहा। 16 नवंबर को अभय सिंह जी का साथ देंगे ना?

### 6. "Abhay singh ne kya kaam kiya gaon me?"
- **Before:** Ram Ram bhaiya! 🙏 Baba Abhay Singh dwara karwaye gaye pramanit mukhya kaam: • Up-swasthya kendra hetu swayam niji zameen daan va Sihali Kalan me pashu aspatal nirman • JJM ghar-ghar meetha peyejal va naye borewell • Pakki damar roads aur satyapit underground drainage lines • Modern digital library va open gym khel maidan! Agar kisi specific kaam ke bare me janna ho to batayein bhaiya! 😊🚩
- **After** _(intent: works, stage: undecided)_: Sihali Khurd aur Sihali Kalan me JJM ki tankiyan, ghar-ghar nal connection aur pipeline ka kaam hua hai, aur 6 naye borewell motor ke saath lage hain. Jin gharon tak nal abhi nahi pahuncha, wahan JJM ka bacha kaam poora karna pehla sankalp hai. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na?

### 7. "पानी की टंकी का क्या हुआ? हमारे यहाँ नल नहीं आता"
- **Before:** राम राम भैया! 💧 पेयजल व्यवस्था (JJM) के तहत बाबा अभय सिंह द्वारा करवाए गए कार्य: • उच्च व निम्न पानी की टंकियां और घर-घर शुद्ध मीठे पानी के नल कनेक्शन! • सिहाली से हाड़ाहेड़ी के सीम संधे पर नए गहरे बोरवेल अधिष्ठापन! • शेष बची ढाणियों तक मीठे पानी की स्थायी लाइन पहुँचाना सर्वोच्च प्राथमिकता है। 🚩
- **After** _(intent: complaint, stage: undecided)_: आपकी बात नोट कर ली है जी, इसे सीधे अभय सिंह जी की प्राथमिकता सूची में डाल रही हूँ। सिहाली खुर्द और सिहाली कलां में JJM की पानी की टंकियाँ, घर-घर नल कनेक्शन और पाइपलाइन का काम हुआ है, और 6 नए बोरवेल मोटर समेत लगे हैं। किस वार्ड/गली की बात है, बता देंगे?

### 8. "hamari gali me naali tooti padi hai 2 mahine se"
- **Before:** Ram Ram bhaiya! 🙏 Baba Abhay Singh (Moti Aangli Wale Baba) Jansampark. Voter parchi dekhne ke liye apna naam likh kar bhejein, ya vikas karyon par charcha karein! 🚩
- **After** _(intent: complaint, stage: undecided)_: Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Hadahedi aur Sihali Khurd me kai jagah underground naali line dali hai; aage lagatar naali aur pakki safai vyavastha ka sankalp hai. Kis ward/gali ki baat hai, bata denge?

### 9. "sadak me bahut gaddhe hai ward 4 me"
- **Before:** Ram Ram bhaiya! 🛣️ Sadak va raaston ke mukhya vikas karya: • Sihali Kalan-Hadahedi main road aur Baba Kundandas Ashram road ka pakka punarnirman hua. • Baniya Wala Kudi se Baba Mathuradas Mandir tak pakki damar road bani. • Aage Sihali Khurd-Hadahedi main link road ka sankalp hai. 🚩
- **After** _(intent: complaint, stage: undecided)_: Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Sihali Kalan–Hadahedi main road pakki damar bani, aur Ashram se Sihali Kalan ka rasta bhi dobara bana. Kis ward/gali ki baat hai, bata denge?

### 10. "hospital me doctor nahi aata"
- **Before:** Ram Ram bhaiya! 🏥 Chikitsa kshetra me Baba Abhay Singh ka yogdan aitihasik hai: • Swayam apni niji zameen daan dekar Sihali Khurd me up-swasthya kendra bhavan banwaya! • Sihali Kalan me Surjan parivar se bhoomi-daan karwake pashu aspatal banwaya. • Aage ka sankalp: Regular doctor deployment va 24hr ambulance! 🚩
- **After** _(intent: complaint, stage: undecided)_: Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Abhay Singh ji ne apni pushtaini zameen daan karke Sihali Khurd me up-swasthya kendra ka bhawan banwaya. Kis ward/gali ki baat hai, bata denge?

### 11. "bijli ka khamba tuta hai"
- **Before:** Ram Ram bhaiya! 🙏 Baba Abhay Singh (Moti Aangli Wale Baba) Jansampark. Voter parchi dekhne ke liye apna naam likh kar bhejein, ya vikas karyon par charcha karein! 🚩
- **After** _(intent: complaint, stage: undecided)_: Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Kis ward/gali ki baat hai, bata denge?

### 12. "बच्चों की पढ़ाई के लिए क्या किया?"
- **Before:** राम राम भैया! 🙏 बाबा अभय सिंह (मोटी आंगली वाले बाबा) जनसंपर्क। वोटर पर्ची देखने के लिए अपना शुभ नाम लिखकर भेजें, या गाँव के विकास कार्यों पर चर्चा करें! 🚩
- **After** _(intent: works, stage: undecided)_: सिहाली खुर्द में बच्चों और युवाओं के लिए मॉड्यूलर लाइब्रेरी बनी है; हाड़ाहेड़ी और सिहाली कलां में भी लाइब्रेरी का संकल्प है। बस इतना सोचिएगा—40 साल से गाँव के सुख-दुख में कौन साथ खड़ा रहा। 16 नवंबर को अभय सिंह जी का साथ देंगे ना?

### 13. "yuvaon ke liye kya hai? naukri ka kya"
- **Before:** Ram Ram bhaiya! 🙏 Baba Abhay Singh (Moti Aangli Wale Baba) Jansampark. Voter parchi dekhne ke liye apna naam likh kar bhejein, ya vikas karyon par charcha karein! 🚩
- **After** _(intent: works, stage: undecided)_: Khel maidan me running track, basketball-badminton-kho kho court aur open gym laga hai, aur library bhi bani hai. Aage Hadahedi va Sihali Kalan me khel maidan aur Sihali Khurd me mini stadium ka sankalp hai. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na?

### 14. "kisan ke liye kya karoge"
- **Before:** Arre wah! Ek number! 👏 Bohot samman hai aapki is mehnat ka bhaiya! Garv hai humein aap par. Accha ek baat batana, kya aap chahte hain ki Baba Abhay Singh ji aapke ghar aayein milne? Baba ji ke darwaze to poore gaon ke liye 24 ghante khule hain! 😊🚩
- **After** _(intent: future, stage: undecided)_: Zameen ke kaam gaon me hon, iske liye patwar ghar banwane ka sankalp hai. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na?

### 15. "आगे क्या करेंगे गाँव के लिए"
- **Before:** राम राम भैया! 🙏 बाबा अभय सिंह (मोटी आंगली वाले बाबा) जनसंपर्क। वोटर पर्ची देखने के लिए अपना शुभ नाम लिखकर भेजें, या गाँव के विकास कार्यों पर चर्चा करें! 🚩
- **After** _(intent: future, stage: undecided)_: आगे हाड़ाहेड़ी व सिहाली कलां में खेल मैदान और सिहाली खुर्द में मिनी स्टेडियम का संकल्प है। बस इतना सोचिएगा—40 साल से गाँव के सुख-दुख में कौन साथ खड़ा रहा। 16 नवंबर को अभय सिंह जी का साथ देंगे ना?

### 16. "meri parchi bhej do"
- **Before:** Ram Ram bhaiya! 🙏 Baba Abhay Singh (Moti Aangli Wale Baba) Jansampark. Voter parchi dekhne ke liye apna naam likh kar bhejein, ya vikas karyon par charcha karein! 🚩
- **After** _(intent: voter_slip, stage: undecided)_: Parchi abhi nikaal deti hoon ji—apna poora naam aur pita/pati ka naam likh bhejiye.

### 17. "मेरा नाम वोटर लिस्ट में है क्या"
- **Before:** राम राम भैया! 🙏 बाबा अभय सिंह (मोटी आंगली वाले बाबा) जनसंपर्क। वोटर पर्ची देखने के लिए अपना शुभ नाम लिखकर भेजें, या गाँव के विकास कार्यों पर चर्चा करें! 🚩
- **After** _(intent: voter_slip, stage: undecided)_: पर्ची अभी निकाल देती हूँ जी—अपना पूरा नाम और पिता/पति का नाम लिख भेजिए।

### 18. "vote kab hai aur kahan dalna hai"
- **Before:** Election Somwar, 16 November 2026 ko hai bhaiya! 🗓️ Matdan: Rajkiya Ucch Madhyamik Vidyalaya, Sihali Khurd (Booth 95, 96, 97, 98). Agar parivar ki voter parchi dekhni ho to bas naam likh kar bhej dena! 🙏
- **After** _(intent: polling, stage: undecided)_: Matdaan Somvar, 16 November 2026 ko subah 7:30 se shaam 5:30 tak Govt. Sr. Sec. School, Sihali Khurd me hai. Apna ward bataiye, booth-room bhi bata doongi.

### 19. "मतदान कब है"
- **Before:** राम राम भैया! 🙏 बाबा अभय सिंह (मोटी आंगली वाले बाबा) जनसंपर्क। वोटर पर्ची देखने के लिए अपना शुभ नाम लिखकर भेजें, या गाँव के विकास कार्यों पर चर्चा करें! 🚩
- **After** _(intent: polling, stage: undecided)_: मतदान सोमवार, 16 नवंबर 2026 को सुबह 7:30 से शाम 5:30 तक राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द में है। अपना वार्ड बताइए, बूथ-कमरा भी बता दूँगी।

### 20. "Baba se milna hai, ghar aao kabhi"
- **Before:** Ji bilkul bhaiya! Aapki baat maine Baba ji ki diary me note kar li hai, jald hi aapke yahan chai peene zaroor aayenge! ☕🚩 Accha, gaon me ya aapki koi khas samasya jiska dhyan rakhna chahiye bhaiya? *(Agar kisi baat me koi kami reh gayi ho to chhota maan kar maaf karna bhaiya, hum to bas gaon ki seva me lage hain! 🙏)*
- **After** _(intent: meeting, stage: undecided)_: Zaroor ji! Mulakat ki baat team ko bhej di hai, jaldi phone aayega. Apna ward aur sahi samay bata dijiye.

### 21. "चौपाल पर कब आओगे"
- **Before:** राम राम भैया! 🙏 बाबा अभय सिंह (मोटी आंगली वाले बाबा) जनसंपर्क। वोटर पर्ची देखने के लिए अपना शुभ नाम लिखकर भेजें, या गाँव के विकास कार्यों पर चर्चा करें! 🚩
- **After** _(intent: meeting, stage: undecided)_: ज़रूर जी! मुलाकात की बात टीम को भेज दी है, जल्द फ़ोन आएगा। अपना वार्ड और सही समय बता दीजिए।

### 22. "pakka vote denge baba ko hi"
- **Before:** Arre dil jeet liya aapne! ❤️🙏🚩 Aapka yahi vishwas aur aashirwad Baba Abhay Singh ji ki asli taakat hai. Is baar Sihali Khurd ke vikas ki jeet pakki hai! Apne parivar aur dosto ko bhi sath jodiyega bhaiya! 😊
- **After** _(intent: commit, stage: committed)_: Dil se dhanyavad ji! 🙏 Aapka yahi bharosa Abhay Singh ji ki asli taakat hai. Ghar ke baaki voters ko bhi saath laaiyega—subah 7:30 se shaam 5:30, Govt. Sr. Sec. School, Sihali Khurd.

### 23. "हम आपके साथ हैं, पूरा परिवार वोट देगा"
- **Before:** राम राम भैया! 🙏 बाबा अभय सिंह (मोटी आंगली वाले बाबा) जनसंपर्क। वोटर पर्ची देखने के लिए अपना शुभ नाम लिखकर भेजें, या गाँव के विकास कार्यों पर चर्चा करें! 🚩
- **After** _(intent: commit, stage: committed)_: दिल से धन्यवाद जी! 🙏 आपका यही भरोसा अभय सिंह जी की असली ताकत है। घर के बाकी वोटरों को भी साथ लेकर आइएगा—सुबह 7:30 से शाम 5:30, राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द।

### 24. "abhi soch rahe hai"
- **Before:** Ram Ram bhaiya! 🙏 Baba Abhay Singh (Moti Aangli Wale Baba) Jansampark. Voter parchi dekhne ke liye apna naam likh kar bhejein, ya vikas karyon par charcha karein! 🚩
- **After** _(intent: undecided, stage: undecided)_: Koi baat nahi ji, soch-samajh kar faisla karna hi sahi hai. Sihali Khurd aur Sihali Kalan me JJM ki tankiyan, ghar-ghar nal connection aur pipeline ka kaam hua hai, aur 6 naye borewell motor ke saath lage hain. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na?

### 25. "देखेंगे, अभी तय नहीं किया"
- **Before:** राम राम भैया! 🙏 बाबा अभय सिंह (मोटी आंगली वाले बाबा) जनसंपर्क। वोटर पर्ची देखने के लिए अपना शुभ नाम लिखकर भेजें, या गाँव के विकास कार्यों पर चर्चा करें! 🚩
- **After** _(intent: undecided, stage: undecided)_: कोई बात नहीं जी, सोच-समझकर फ़ैसला करना ही सही है। सिहाली खुर्द और सिहाली कलां में JJM की पानी की टंकियाँ, घर-घर नल कनेक्शन और पाइपलाइन का काम हुआ है, और 6 नए बोरवेल मोटर समेत लगे हैं। बस इतना सोचिएगा—40 साल से गाँव के सुख-दुख में कौन साथ खड़ा रहा। 16 नवंबर को अभय सिंह जी का साथ देंगे ना?

### 26. "hum vote nahi denge kisi aur ko denge"
- **Before:** Arre koi baat nahi bhaiya... Hum aapki baat ka pura samman karte hain. Kya hamare kaam me koi kami lagi, ya koi parivarik dabav hai bhaiya? Hum aapke aur gaon ke liye kya sudhar kar sakte hain, zaroor batana! 🙏
- **After** _(intent: opposed, stage: opposed)_: Aapki raay ka samman hai ji. Bas itna bata dijiye—kaun si baat aapko khatak rahi hai? Sahi baat seedhe Abhay Singh ji tak pahunchegi.

### 27. "40 saal me kya kiya kuch nahi kiya"
- **Before:** Ram Ram bhaiya! 🙏 Baba Abhay Singh (Moti Aangli Wale Baba) Jansampark. Voter parchi dekhne ke liye apna naam likh kar bhejein, ya vikas karyon par charcha karein! 🚩
- **After** _(intent: taunt, stage: undecided)_: Sawal poochna aapka haq hai ji. Sihali Khurd aur Sihali Kalan me JJM ki tankiyan, ghar-ghar nal connection aur pipeline ka kaam hua hai, aur 6 naye borewell motor ke saath lage hain. Jis jagah kaam adhoora lage, us gali/ward ka naam bataiye—Abhay Singh ji khud dekhenge. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na?

### 28. "सब झूठ बोलते हो चुनाव में"
- **Before:** राम राम भैया! 🙏 बाबा अभय सिंह (मोटी आंगली वाले बाबा) जनसंपर्क। वोटर पर्ची देखने के लिए अपना शुभ नाम लिखकर भेजें, या गाँव के विकास कार्यों पर चर्चा करें! 🚩
- **After** _(intent: taunt, stage: undecided)_: सवाल पूछना आपका हक़ है जी। सिहाली खुर्द और सिहाली कलां में JJM की पानी की टंकियाँ, घर-घर नल कनेक्शन और पाइपलाइन का काम हुआ है, और 6 नए बोरवेल मोटर समेत लगे हैं। जिस जगह काम अधूरा लगे, उस गली/वार्ड का नाम बताइए—अभय सिंह जी खुद देखेंगे। बस इतना सोचिएगा—40 साल से गाँव के सुख-दुख में कौन साथ खड़ा रहा। 16 नवंबर को अभय सिंह जी का साथ देंगे ना?

### 29. "kitna paisa doge vote ka"
- **Before:** Ram Ram bhaiya! 🙏 Baba Abhay Singh (Moti Aangli Wale Baba) Jansampark. Voter parchi dekhne ke liye apna naam likh kar bhejein, ya vikas karyon par charcha karein! 🚩
- **After** _(intent: bribe, stage: unknown)_: Ji, yahan koi paisa, daaru ya laalach nahi diya jata—ye kanoon ke khilaf bhi hai. Abhay Singh ji 40 saal ki seva aur kaam ke bharose vote maangte hain. 🙏

### 30. "daru milegi kya"
- **Before:** Arre bhaiya, 5 din ki daru-murge ya 500 ke note se 5 saal ka gaon thodi sanwarta hai! Jo chunav aate hi laalach baant-te hain wo 5 saal nazar bhi nahi aate. Humein to apne wahi imandar Baba Abhay Singh chahiye jo aadhi raat ko bhi bina kisi lalach ke sukh-dukh me sath khade mile! Baki aap khud samajhdar ho bhaiya! 😊🚩
- **After** _(intent: bribe, stage: unknown)_: Ji, yahan koi paisa, daaru ya laalach nahi diya jata—ye kanoon ke khilaf bhi hai. Abhay Singh ji 40 saal ki seva aur kaam ke bharose vote maangte hain. 🙏

### 31. "bc kya bakwas hai"
- **Before:** Aapke vicharon ka pura samman hai bhaiya, par hum kisi behas ya galat bhasha me nahi padte. Hum to bas gaon ki seva aur Baba ji ke vikas karyon ki jankari ke liye hain. Aapke aur aapke parivar ke liye bohot shubhkamnayein! 🙏
- **After** _(intent: abuse, stage: unknown)_: Aapki narazgi samajh sakte hain ji. Gaali se baat nahi banegi—koi asli shikayat ho to bataiye, seedhe Abhay Singh ji tak pahunchaungi. 🙏

### 32. "achha kaam kiya hai baba ne"
- **Before:** Ram Ram bhaiya! 🙏 Baba Abhay Singh dwara karwaye gaye pramanit mukhya kaam: • Up-swasthya kendra hetu swayam niji zameen daan va Sihali Kalan me pashu aspatal nirman • JJM ghar-ghar meetha peyejal va naye borewell • Pakki damar roads aur satyapit underground drainage lines • Modern digital library va open gym khel maidan! Agar kisi specific kaam ke bare me janna ho to batayein bhaiya! 😊🚩
- **After** _(intent: positive, stage: leaning)_: Aapke aashirwad ke liye dhanyavad ji! 🙏 To pakka raha? 16 Nov ko Abhay Singh ji ko vote denge na?

### 33. "ok"
- **Before:** Ji bilkul bhaiya! Koi bhi aur jankari chahiye ho ya voter parchi dekhni ho, to bina kisi jhijhak ke likh dena. Baba Abhay Singh ki team hamesha aapke sath hai! 😊🚩
- **After** _(intent: thanks, stage: unknown)_: Ji ji 🙏 16 November ko Abhay Singh ji ka saath denge na?

### 34. "धन्यवाद"
- **Before:** राम राम भैया! 🙏 बाबा अभय सिंह (मोटी आंगली वाले बाबा) जनसंपर्क। वोटर पर्ची देखने के लिए अपना शुभ नाम लिखकर भेजें, या गाँव के विकास कार्यों पर चर्चा करें! 🚩
- **After** _(intent: thanks, stage: unknown)_: जी जी 🙏 16 नवंबर को अभय सिंह जी का साथ देंगे ना?

### 35. "ward 3"
- **Before:** Ram Ram bhaiya! 🙏 Baba Abhay Singh (Moti Aangli Wale Baba) Jansampark. Voter parchi dekhne ke liye apna naam likh kar bhejein, ya vikas karyon par charcha karein! 🚩
- **After** _(intent: gave_ward, stage: unknown)_: Ward 3 note kar liya ji. Aapka booth 95, room 1 rahega. 16 November ko Abhay Singh ji ka saath denge na?

### 36. "7"
- **Before:** Ram Ram bhaiya! 🙏 Baba Abhay Singh (Moti Aangli Wale Baba) Jansampark. Voter parchi dekhne ke liye apna naam likh kar bhejein, ya vikas karyon par charcha karein! 🚩
- **After** _(intent: gave_ward, stage: unknown)_: Ward 7 note kar liya ji. Aapka booth 97, room 3 rahega. 16 November ko Abhay Singh ji ka saath denge na?

### 37. "pension nahi mil rahi buzurgon ko"
- **Before:** Ram Ram tauji! 🙏 Baba Abhay Singh (Moti Aangli Wale Baba) Jansampark. Voter parchi dekhne ke liye apna naam likh kar bhejein, ya vikas karyon par charcha karein! 🚩
- **After** _(intent: complaint, stage: undecided)_: Aapki baat note kar li hai Mata ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Buzurgon ke liye pankhe aur paani wali chaupal ka sankalp hai. Pension ka koi kaam atka ho to naam-ward bataiye, team saath jaakar madad karegi. Kis ward/gali ki baat hai, bata denge?

### 38. "बेटियों की सुरक्षा का क्या"
- **Before:** राम राम भैया! 🙏 बाबा अभय सिंह (मोटी आंगली वाले बाबा) जनसंपर्क। वोटर पर्ची देखने के लिए अपना शुभ नाम लिखकर भेजें, या गाँव के विकास कार्यों पर चर्चा करें! 🚩
- **After** _(intent: works, stage: undecided)_: मुख्य रास्तों, गाँव के प्रवेश और चौराहों पर CCTV और रोड लाइट लगवाने का संकल्प है, ताकि बहन-बेटियाँ बेफिक्र आ-जा सकें। बस इतना सोचिएगा—40 साल से गाँव के सुख-दुख में कौन साथ खड़ा रहा। 16 नवंबर को अभय सिंह जी का साथ देंगे ना?

### 39. "shmashan ghat ka kaam hua kya"
- **Before:** Ram Ram bhaiya! 🕊️ Mokshdham va paryavaran sanrakshan ke kaam: • Mokshdham ka mitti bharat, samtlikaran, 2 naye borewell aur paani ki tanki! • Paramparik johadon ki gehari khudai va ped-paudhe lagane ka kaam. 🌳🚩
- **After** _(intent: works, stage: undecided)_: Shmashan me bharav-samtalikaran, do borewell, paani ki tanki aur peene ke paani ki vyavastha hui hai. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na?

### 40. "asdkj qwe zzz lorem ipsum dolor amet blah random text here"
- **Before:** Ram Ram bhaiya! 🙏 Baba Abhay Singh (Moti Aangli Wale Baba) Jansampark. Voter parchi dekhne ke liye apna naam likh kar bhejein, ya vikas karyon par charcha karein! 🚩
- **After** _(intent: unclear, stage: unknown)_: Maaf kijiye ji, theek se samajh nahi paayi. Aapko voter parchi chahiye, gaon ki koi samasya batani hai, ya Abhay Singh ji se kuch poochna hai?

