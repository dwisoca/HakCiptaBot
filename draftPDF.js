const spinner = require('simple-spinner');
const { jsPDF } = require('jspdf');
const pdfPoppler = require('pdf-poppler');
const fs = require('fs');
const path = require('path');
const jsQR = require("jsqr");
const PNG = require('pngjs').PNG;
const colors = require('colors');

let qrNotFound = []

module.exports.draftBerkas = async function (pdfPath){
    const loading = ["🕛 ",
    "🕐 ",
    "🕑 ",
    "🕒 ",
    "🕓 ",
    "🕔 ",
    "🕕 ",
    "🕖 ",
    "🕗 ",
    "🕘 ",
    "🕙 ",
    "🕚 "]
    qrNotFound = []
    try {    
        const pdf = pdfPath.replace(/\\/g, '/');
        console.log(pdf)

        let files = await readFilesFromFolder()
        if (files.length > 0 ){
            clearTemp(files)
        }

        console.log(colors.blue.bold('1. Convert PDF to PNG'))
        spinner.change_sequence(loading);
        spinner.start();
        await pdfToImage(pdf)
        spinner.stop();
        console.log('~ PDF converted to image successfully!');
        
        console.log(colors.blue.bold('2. Reading All QR Code'))
        spinner.start();
        files = await readFilesFromFolder()
        const qrcode = await readQRCode(files)
        spinner.stop();
        console.log('~ Total qr code found: ', qrcode.length)
        console.log('~ Total qr code not found: ', qrNotFound.length)
        // console.log(qrcode)

        const resultJSON = transformArrayToJSON(qrcode);
        // console.log(resultJSON);
        // console.log(JSON.stringify(resultJSON))

        // convert to PDF
        console.log(colors.blue.bold('3. Convert to PDF'))
        for (const parentId in resultJSON) {
            if (resultJSON.hasOwnProperty(parentId)) {
                const parent = resultJSON[parentId];
                console.log(`   → processing id ${parentId}`);
                // console.log(parent);
                const formulirPosition = parent['formulir']['position']
                const pengalihanPosition = parent['pengalihan']['position']
                const pernyataanPosition = parent['pernyataan']['position']
                // console.log(formulirPosition)
                const pdfFormulir = await saveToPDF(parentId, 'formulir', formulirPosition)
                // console.log(pengalihanPosition)
                const pdfPengalihan = await saveToPDF(parentId, 'pengalihan', pengalihanPosition)
                // console.log(pernyataanPosition)
                const pdfPernyataan = await saveToPDF(parentId, 'pernyataan', pernyataanPosition)
            }
        }

        console.log('~ All PDF successfully saved')

        console.log(colors.blue.bold('4. Upload to Google Drive'))
        console.log(colors.blue.bold('5. Update Database'))

        const filesDone = files.filter(item => !qrNotFound.includes(item))
        clearTemp(filesDone)
        
        if (qrNotFound.length > 0){
            console.log(colors.yellow.bold('**WARNING!!!**'))
            console.log(colors.yellow('-Halaman berikut belum dimasukkan: ') + qrNotFound.join(', '))
            // console.log(qrNotFound)
        }

        return qrNotFound
        
    } catch (error) {
        console.error(error);
        return error
    }
}

async function pdfToImage(pdfPath){
    const outputFolder = path.join(__dirname, 'temp');
    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder);
    }
    // Convert pdf to jpg
    const opts = {
        format: 'png',
        out_dir: 'temp',
        out_prefix: 'output',
        scale: 4096,
        page: null
      };
    try {
        await pdfPoppler.convert(pdfPath, opts);
    } catch (error) {
        console.error('Error converting PDF to image:', error);
    }
}

async function saveToPDF(id, category, filePosition){
    // Create a new PDF document
    const doc = new jsPDF();

    const a4Width = doc.internal.pageSize.getWidth();
    const a4Height = doc.internal.pageSize.getHeight();
    
    for (let i = 0; i < filePosition.length; i++) {
        const imageFile = `temp/output-${filePosition[i].toString().padStart(2, '0')}.png`
        // console.log(filePosition[i], imageFile)

        // Load PNG file
        const pngData = fs.readFileSync(imageFile);
        const png = new PNG(pngData);

        doc.addPage()
        // Add the PNG image to the PDF
        doc.addImage(pngData, 'PNG', 0, 0, a4Width, a4Height);
        
        if (i == filePosition.length-1){
            const outputFile = `download/${id}-${category}.pdf`
            // console.log(outputFile)
            // Delete first blank page
            doc.deletePage(1)
            // Save the PDF to the specified output path
            doc.save(outputFile);
            return outputFile
        }
    }

}

async function readQRCode(files){
    let qrResult = []
    for (let i = 0; i < files.length; i++) {
        const element = files[i];
        const imagePath = 'temp/' + element;
        // console.log('Read qr from file: ', element);
    
        try {
          const data = await readPNGFile(imagePath);
          const qrOptions = {
            inversionAttemps: 'attempBoth'
          }
          const code = jsQR(data.data, data.width, data.height, qrOptions);
          
          if (code) {
            // console.log("Found QR code", code.data);
            qrResult.push(code.data + `_${element}`);
          } else {
            // console.error("---No QR found for file above---")
            qrResult.push('blank')
            qrNotFound.push(element)
          }
        } catch (error) {
          console.error('Error reading PNG file:', error);
        }

        if (i == files.length-1){
            return qrResult
        }
    }
}

async function readFilesFromFolder() {
    try {
        return fs.readdirSync('temp');
    } catch (error) {
        console.error(`Error reading files from temp:`, error);
        return [];
    }
}

function readPNGFile(filePath) {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath)
        .pipe(new PNG())
        .on('parsed', function() {
            const result = {
                data: this.data,    // Uint8ClampedArray
                width: this.width,
                height: this.height
              };
            resolve(result);
        })
        .on('error', reject);
        
        stream.on('end', function() {
        // The end event is emitted when there is no more data to read.
        // This can be useful if you need to perform additional logic after reading.
        });
    });
}

function transformArrayToJSON(inputArray) {
    const result = {};

    inputArray.forEach((item, index) => {
        if (item.includes('blank')){
            return
        }
        const [id, rest] = item.split('/');
        const [categoryPage, fileName] = rest.split('_');
        const [category, pageNum] = categoryPage.split('(');

        if (!result[id]) {
        result[id] = {};
        }

        if (!result[id][category]) {
        result[id][category] = {
            fileName: `${category}-${id}`,
            totalPage: 0,
            position: [],
        };
        }

        result[id][category].totalPage = Math.max(result[id][category].totalPage, parseInt(pageNum, 10));
        result[id][category].position.push({ position: index + 1, page: parseInt(pageNum, 10) });
    });

    // Sort the positions array based on page numbers
    Object.keys(result).forEach(id => {
        Object.keys(result[id]).forEach(category => {
        result[id][category].position.sort((a, b) => a.page - b.page);
        result[id][category].position = result[id][category].position.map(item => item.position);
        });
    });

    return result;
}

function clearTemp(files){
    files.forEach(element => {
        const imagePath = 'temp/' + element;

        fs.unlink(imagePath, (err) => {
            if (err) {
            console.error(`Error: ${err}`);
            } else {
            // console.log(imagePath + ' has been deleted');
            }
        });
    });
}