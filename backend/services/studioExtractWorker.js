// CPU-bound document parsing stays off the request thread and has a parent deadline.
const {parentPort,workerData}=require('node:worker_threads');
const {inflateRawSync}=require('node:zlib');
const path=require('node:path');
const MAX_TEXT=80000, MAX_PAGES=40;
const clean=s=>s.replace(/<[^>]*>/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
// Read only known XML parts. Bounds apply before decompression; archives never touch disk.
function officeParts(buf,ext) {
    let end=-1;
    for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--)if(buf.readUInt32LE(i)===0x06054b50){end=i;break;}
    if(end<0)throw new Error('This Office file is not a supported ZIP document.');
    const count=buf.readUInt16LE(end+10);let pos=buf.readUInt32LE(end+16),size=0,actualSize=0;
    if(count>2000)throw new Error('This Office archive contains too many parts.');
    const parts=[];
    for(let i=0;i<count;i++) {
        if(pos+46>buf.length||buf.readUInt32LE(pos)!==0x02014b50)throw new Error('Invalid archive directory.');
        const flags=buf.readUInt16LE(pos+8),method=buf.readUInt16LE(pos+10),compressed=buf.readUInt32LE(pos+20),expanded=buf.readUInt32LE(pos+24),nameLen=buf.readUInt16LE(pos+28),extra=buf.readUInt16LE(pos+30),comment=buf.readUInt16LE(pos+32),offset=buf.readUInt32LE(pos+42);
        const name=buf.subarray(pos+46,pos+46+nameLen).toString('utf8');pos+=46+nameLen+extra+comment;
        const match=ext==='docx'?name==='word/document.xml':/^ppt\/slides\/slide\d+\.xml$/.test(name);
        if(!match)continue;
        size+=expanded;
        if(size>8*1024*1024||flags&1||![0,8].includes(method)||offset+30>buf.length)throw new Error('Encrypted or oversized document parts are unsupported.');
        if(buf.readUInt32LE(offset)!==0x04034b50)throw new Error('Invalid document part.');
        const start=offset+30+buf.readUInt16LE(offset+26)+buf.readUInt16LE(offset+28);
        if(start+compressed>buf.length)throw new Error('Truncated document part.');
        const bytes=buf.subarray(start,start+compressed);
        const decoded=method===0?bytes:inflateRawSync(bytes,{maxOutputLength:8*1024*1024});
        actualSize+=decoded.length;
        if(decoded.length!==expanded||actualSize>8*1024*1024)throw new Error('The expanded document exceeds its size limit.');
        const xml=decoded.toString('utf8');
        parts.push({name,text:clean(xml.replace(/<\/(?:w:p|a:p)>/g,'\n'))});
    }
    return parts.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
}
async function extract() {
    const raw=Buffer.from(workerData.data,'base64'),ext=path.extname(workerData.name).slice(1).toLowerCase();
    let pages=[],warning='';let worker;
    const ocr=async bytes=>{
        if(!worker){const {createWorker}=require('tesseract.js');worker=await createWorker('eng+hin',1,{langPath:path.join(__dirname,'..'),gzip:false});}
        const {data}=await worker.recognize(bytes);return {text:data.text.trim(),confidence:Math.round(data.confidence||0)};
    };
    try {
        if(['txt','md','csv','json','log'].includes(ext)&&!raw.includes(0))pages=[{page:1,text:raw.toString('utf8'),method:'text'}];
        else if(['docx','pptx'].includes(ext)) {
            pages=officeParts(raw,ext).map((p,i)=>({page:i+1,text:p.text,method:ext==='pptx'?'slide':'document'}));
            warning=ext==='docx'?'Word text is one document section; section numbers are not printed page numbers. Images and equations need visual review.':'Slide text extracted; embedded images, charts and equations need visual review.';
        } else if(ext==='pdf') {
            if(!raw.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('The file does not contain a valid PDF header.');
            const {getDocumentProxy,renderPageAsImage}=await import('unpdf');
            const pdf=await getDocumentProxy(new Uint8Array(raw));let scans=0;
            try {
                for(let n=1;n<=Math.min(pdf.numPages,MAX_PAGES);n++) {
                    const page=await pdf.getPage(n),data=await page.getTextContent();
                    let text=data.items.map(x=>x.str||'').join(' ').trim(),method='text',confidence=null;
                    if(text.length<40&&scans<5){
                        const viewport=page.getViewport({scale:1});
                        const scale=Math.min(1.5,1800/Math.max(viewport.width,viewport.height));
                        const png=await renderPageAsImage(pdf,n,{canvasImport:()=>import('@napi-rs/canvas'),scale});
                        const result=await ocr(Buffer.from(png));text=result.text;confidence=result.confidence;method='ocr';scans++;
                    }
                    pages.push({page:n,text,method,confidence});
                }
                if(pdf.numPages>MAX_PAGES)warning=`Only the first ${MAX_PAGES} of ${pdf.numPages} pages were extracted. Split the file to read the rest. `;
            } finally {await pdf.loadingTask.destroy();}
            warning+='OCR is limited to five scanned pages per extraction. Check equations, diagrams and unreadable pages before use.';
        } else if(['png','jpg','jpeg','webp'].includes(ext)) {
            const {loadImage,createCanvas}=require('@napi-rs/canvas');
            const img=await loadImage(raw);
            if(img.width*img.height>32000000)throw new Error('Choose an image below 32 megapixels.');
            const scale=Math.min(1,2000/Math.max(img.width,img.height)),canvas=createCanvas(Math.max(1,Math.round(img.width*scale)),Math.max(1,Math.round(img.height*scale)));
            canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
            const result=await ocr(canvas.toBuffer('image/png'));
            pages=[{page:1,...result,method:'ocr'}];warning='OCR can misread handwriting and equations. Review and correct the text.';
        } else return {status:'unsupported',pages:[],warning:'Stored as an attachment. Text extraction supports PDF, JPG, JPEG, PNG, WebP, DOCX, PPTX and plain text. Paste a transcript for other formats.'};
        let remaining=MAX_TEXT;
        pages=pages.slice(0,MAX_PAGES).map(p=>{const text=p.text.slice(0,Math.max(0,remaining));remaining-=text.length;return {...p,text};});
        if(remaining===0)warning+=' Text was limited to 80,000 characters.';
        return {status:pages.some(p=>p.text.trim())?'ready':'failed',pages,warning:warning||'Text extracted. Review its accuracy before creating materials.'};
    } finally {if(worker)await worker.terminate();}
}
extract().then(r=>parentPort.postMessage(r)).catch(e=>parentPort.postMessage({status:'failed',pages:[],warning:String(e.message).slice(0,800)}));
