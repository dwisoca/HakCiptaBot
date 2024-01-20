const express = require('express')
const puppeteer = require('puppeteer')
var admin = require("firebase-admin")
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
var serviceAccount = require("./serviceAccountKey.json");
require('dotenv').config()
const path = require('path');
const downloadPath = path.resolve('./download');
// GDrive
const { google } = require('googleapis');
const {authenticate} = require('@google-cloud/local-auth');
const oauthCredentials = path.join(process.cwd(), 'oauthCredentials.json');
const TOKEN_PATH = path.join(process.cwd(), 'DownloadFileToken.json');
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const fs = require('fs');
const { file } = require('googleapis/build/src/apis/file');
const fsp = fs.promises;

  // Firebase Init
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://e-hakcipta-default-rtdb.asia-southeast1.firebasedatabase.app"
  });
  // var db = admin.database();
  const db = getFirestore();

  // Express
  const app = express()
  const port = 5000

  //Template data
  const jenisCiptaan = ['Karya Tulis', 'Karya Seni', 'Komposisi Musik' , 'Karya Audio Visual', 'Karya Fotografi', 'Karya Drama & Koreografi', 'Karya Lainnya', 'Karya Rekaman']
  const formatDate = new Intl.DateTimeFormat("en-US", {
      dateStyle: "short"
  })

  // GOOGLE DRIVE LOGIN AND SAVE SESSION
  async function authorize() {
    let client = await loadSavedCredentialsIfExist();
    if (client) {
        authClient2 = client
        return client;
    }
    console.log('Autentikasi Google Drive');
    client = await authenticate({
        scopes: SCOPES,
        keyfilePath: oauthCredentials, // Google Drive API credentials JSON
    });
    if (client.credentials) {
        await saveCredentials(client);
    }
    authClient2 = client
    return client;
  }
  async function loadSavedCredentialsIfExist() {
    try {
        const content = await fsp.readFile(TOKEN_PATH);
        const credentials = JSON.parse(content);
        return google.auth.fromJSON(credentials);
    } catch (err) {
        return null;
    }
  }
  async function saveCredentials(client) {
    const content = await fsp.readFile(oauthCredentials);
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
    });
    await fsp.writeFile(TOKEN_PATH, payload);
  }

  app.get('/', async (req, res) => {
      res.send('Memproses: ' + req.query.id)
      console.log('Mulai memproses: (ID) ' + req.query.id)

      // FIRESTORE
      const ciptaanRef = db.collection('ciptaan2').doc(req.query.id);
      const doc = await ciptaanRef.get();
      if (!doc.exists) {
        console.log('No such document!');
      } else {
        // console.log('Document data:', doc.data());
        await botSubmit(doc.data())
          
        console.log('Selesai')
      }

  })

  let ciptaanRef
  let folderID
  app.get('/getsertifikat/', async (req, res) => {
    res.send('Proses Sertifikat')
    console.log('------')

    folderID = req.query.folderID.replace('https://drive.google.com/drive/folders/','')
    const startOfDay = req.query.startOfDay
    const endOfDay = req.query.endOfDay
    const startCiptaan = parseInt(req.query.limitCiptaan) - 1
    
    if (startCiptaan || endOfDay || startOfDay){
      console.log(startOfDay, endOfDay, startCiptaan)
      // Bulk Mode (Rekap Billing)
      ciptaanRef = db.collection('ciptaan2')
      const query = await ciptaanRef.where('tanggalBayar', '>=', parseInt(startOfDay)).where('tanggalBayar', '<=', parseInt(endOfDay)).get()
  
      if (query.empty) {
          console.log('No such document!');
      } else {
          console.log(`Ditemukan ${query.size} dokumen`)
          console.log('Mulai Mencari Sertifikat')
  
          for (let i = startCiptaan; i < query.size && fileFound; i++) {
              fileFound = false
              const doc = query.docs[i];
              console.log(doc.id, '=>', doc.data().judul);  
              
              ciptaanRef = db.collection('ciptaan2').doc(doc.data().id);
              await botGetSertifikat(doc.data()) 
              
              // interval = setInterval(checkFolder, 1000); // 1000 milliseconds = 1 second
              while (!fileFound) {
                // console.log('File Belum ada')
                await checkFolder()
                await sleep(1500);
              }
              
              console.log('File ada')
              // Auth Google Drive
              console.log('Akses Google Drive');
              await authorize();

              // Upload to Drive
              console.log('Mulai Upload');
              const idFile = await uploadFile()
              
              // Set Permission
              console.log('Mengatur File Sharing', idFile.id);
              await shareFile(idFile.id)

              // Upload to Firestore
              console.log('Update URL di aplikasi Hak Cipta')
              await updateFirestore(idFile.url.replace("?usp=drivesdk", ""))
              
              console.log('Selesai')
          }
      }
    } else {
      // One by One Mode
      console.log('Mulai memproses: (ID) ' + req.query.id)

      ciptaanRef = db.collection('ciptaan2').doc(req.query.id);
      const doc = await ciptaanRef.get();
      if (!doc.exists) {
        console.log('No such document!');
      } else {
        // Get Sertifikat From DJKI
        console.log('Mulai Mencari Sertifikat');
        await botGetSertifikat(doc.data())
        fileFound = false
        // interval = setInterval(checkFolder, 1000); // 1000 milliseconds = 1 second
        while (!fileFound) {
          // console.log('File Belum ada')
          await checkFolder()
          await sleep(1500);
        }
        console.log('File ada')
        // Auth Google Drive
        console.log('Akses Google Drive');
        await authorize();

        // Upload to Drive
        console.log('Mulai Upload');
        const idFile = await uploadFile()
        
        // Set Permission
        console.log('Mengatur File Sharing', idFile.id);
        await shareFile(idFile.id)

        // Upload to Firestore
        console.log('Update URL di aplikasi Hak Cipta')
        await updateFirestore(idFile.url.replace("?usp=drivesdk", ""))
        
        console.log('Selesai')
      }
    }
  })

  const { draftBerkas } = require('./draftPDF')
  // Middleware to parse JSON bodies
  app.use(express.text());
  app.post('/draft-berkas', async (req, res) => {
    try {
      const pdfPath = req.body;
      // console.log(pdfPath)
      if (!pdfPath) {
        return res.status(400).json({ error: 'PDF path is required.' });
      }
  
      const result = await draftBerkas(pdfPath);
      // console.log(result)
      
      res.json({ success: true, data: result });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
  })

  let browser
  
  async function botSubmit(items){
    if(!browser) {
        browser = await puppeteer.launch({
          headless: false,
          defaultViewport: false,
          userDataDir: "./tmp"
        });
      }
    
    const page = await browser.newPage();
    await page.goto('https://e-hakcipta.dgip.go.id/index.php/login');
    const url = await page.url();
    console.log(url)
    await page.waitForTimeout(2000)

    
    if(url == 'https://e-hakcipta.dgip.go.id/index.php/login'){
      // Login
      console.log("Prosess login")
      await page.type('[placeholder="Email"]', process.env.USER_ID)
      await page.type('[placeholder="Password"]', process.env.USER_KEY)
      page.click('[type="submit"]')
      
      await page.waitForNavigation({
          waitUntil: 'networkidle0',
      });
    }
    
    await page.goto('https://e-hakcipta.dgip.go.id/index.php/register/hakcipta');
    await page.waitForSelector('[id="modal_unduh"]', {
        visible: true,
      });
      await page.waitForTimeout(process.env.WAKTU_TUNGGU)
    await page.click('[data-dismiss="modal"]')
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)

    // Detail Ciptaan
    await inputDetail(page, items)
    
    // Pencipta         
    await inputPencipta(page, items)

    // Lampiran
    // await inputLampiran(page, items)

    // Pemegang Hak cipta
    await inputPemegang(page)
    
  }

  async function inputDetail(page, items){
    console.log("Proses detail ciptaan")
    const inputJenisPermohonan = (await page.$('[name="jenis_permohonan"]'))
    if (inputJenisPermohonan == null){
      console.log('\x1b[41m-Tidak ditemukan element: inputJenisPermohonan \x1b[0m')
      return
    }
    console.log("- inputJenisCiptaan")
    const inputJenisCiptaan = (await page.$('[name="_main_type"]'))
    const inputSubJenisCiptaan = (await page.$('[id="type-dropdown"]'))
    
    console.log("- inputJenisPermohonan")
    inputJenisPermohonan.select("umkm")
    inputJenisCiptaan.select((jenisCiptaan.indexOf(items.jenis)+1).toString())
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)
    
    console.log("- inputSubJenisCiptaan")
    const option = (await page.$x(`//*[@id="type-dropdown"]/option[text()="${items.subJenis}"]`))[0]
    const optionValue = await (await option.getProperty('value')).jsonValue();
    inputSubJenisCiptaan.select(optionValue)
    
    console.log("- inputJudul")
    const inputJudul = (await page.$x('//*[@id="createform"]/div[1]/div[2]/div/div[4]/div/input'))[0]
    await inputJudul.type(items.judul)
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)
    
    console.log("- inputDeskripsi")
    const inputDeskripsi = (await page.$x('//*[@id="createform"]/div[1]/div[2]/div/div[5]/div/textarea'))[0]
    await inputDeskripsi.type(items.deskripsi)
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)
    await page.keyboard.press("Tab")
    
    console.log("- inputTanggal")
    const tanggal = new Date(items.tanggal)
    const fullDate = `${tanggal.getFullYear()}-${tanggal.getMonth()+1}-${tanggal.getDate()}`
    const inputTanggal = (await page.$x('//*[@id="createform"]/div[1]/div[2]/div/div[6]/div/div/input[2]'))[0]
    inputTanggal.type(fullDate)
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)
    await page.keyboard.press("Tab")
    
    console.log("- inputKotaCiptaan")
    const inputKotaCiptaan = (await page.$x('//*[@id="FindCityAnnounced"]'))[0]
    await inputKotaCiptaan.type(items.kotaCiptaan)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press("Enter")
  }

  async function inputPencipta(page, items){
    console.log("Proses pencipta")
    const tblAddPencipta = (await page.$x('//*[@id="createform"]/div[3]/div[3]/a'))[0]
    // for(let i = 0; i < 1; i++) {
    for(let i = 0; i < items.pencipta.length; i++) {
      console.log("---PENCIPTA KE "+ i +"---")
      console.log("- Open Modal Pencipta")
      tblAddPencipta.click()
      await page.waitForSelector('[id="modal_template"]', {
        visible: true,
      }); 
      await page.waitForTimeout(2000)

      //PILIHAN BADAN HUKUM
      // console.log("- Pilih Badan Hukum")
      // for (let index = 0; index < 12; index++) {
      //   await page.keyboard.press("Tab")
      //   await page.waitForTimeout(100)
      // }
      // await page.keyboard.press("Enter")
      // await page.keyboard.type("tidak")
      // await page.waitForTimeout(process.env.WAKTU_TUNGGU)
      // await page.keyboard.press("Enter")

      console.log("- NEXT PAGE")
      const tblNext1Pencipta = (await page.$x('//*[@id="next"]'))[0]
      tblNext1Pencipta.click()
      await page.waitForTimeout(process.env.WAKTU_TUNGGU)

      console.log("- inputNamaPencipta")
      const inputNamaPencipta = (await page.$x('//*[@id="data_pencipta"]/div[2]/div/input'))[0]
      await inputNamaPencipta.type(items.pencipta[i].nama)
      // await page.waitForTimeout(process.env.WAKTU_TUNGGU)

      console.log("- inputEmailPencipta")
      const inputEmailPencipta = (await page.$x('//*[@id="data_pencipta"]/div[3]/div/input'))[0]
      await inputEmailPencipta.type(items.pencipta[i].email)
      // await page.waitForTimeout(process.env.WAKTU_TUNGGU)

      console.log("- inputHpPencipta")
      const inputHpPencipta = (await page.$x('//*[@id="data_pencipta"]/div[4]/div/input'))[0]
      await inputHpPencipta.type(items.pencipta[i].hp)
      // await page.waitForTimeout(process.env.WAKTU_TUNGGU)

      if (items.pencipta[i].kewarganegaraan != 'Indonesia'){
        console.log("- inputNationality")
        const inputNationalityBox = (await page.$x('//*[@id="data_pencipta"]/div[5]/div/select'))[0]
        inputNationalityBox.click()
        await page.waitForTimeout(process.env.WAKTU_TUNGGU)
        const inputNationality = (await page.$x('/html/body/span/span/span[1]/input'))[0]
        await inputNationality.type(items.pencipta[i].kewarganegaraan)
        await page.waitForTimeout(process.env.WAKTU_TUNGGU)
        await page.keyboard.press("Enter")
      }

      console.log("- NEXT PAGE")
      tblNext1Pencipta.click()
      await page.waitForTimeout(process.env.WAKTU_TUNGGU)

      console.log("- inputAlamat")
      const inputAlamat = (await page.$x('//*[@id="alamat_pencipta"]/div[2]/div/textarea'))[0]
      await inputAlamat.type(items.pencipta[i].alamat)
      // await page.waitForTimeout(process.env.WAKTU_TUNGGU)
      // await page.keyboard.press("Tab")

      if (items.pencipta[i].negara == 'Indonesia'){
        console.log("- inputProvinsi")
        const inputProvinsiBox = (await page.$x('//*[@id="alamat_pencipta"]/div[4]/div/select'))[0]
        inputProvinsiBox.click()
        await page.waitForTimeout(process.env.WAKTU_TUNGGU)
        const inputProvinsi = (await page.$x('/html/body/span/span/span[1]/input'))[0]
        await inputProvinsi.type(items.pencipta[i].provinsi)
        await page.waitForTimeout(process.env.WAKTU_TUNGGU)
        console.log("provinsi" + items.pencipta[i].provinsi)
        if (items.pencipta[i].provinsi == 'RIAU'){
          await page.keyboard.press('ArrowDown')
        }
        await page.waitForTimeout(process.env.WAKTU_TUNGGU)
        await page.keyboard.press("Enter")
      }

      // --> KOTA DOUBLE INPUT
      console.log("- inputKota")
      const inputKotaCiptaan = (await page.$x('//*[@id="alamat_pencipta"]/div[5]/div/select'))[0]
      inputKotaCiptaan.click()
      await page.waitForTimeout(process.env.WAKTU_TUNGGU)
      const inputKota1 = (await page.$x('/html/body/span/span/span[1]/input'))[0]
      await inputKota1.type(items.pencipta[i].kota)
      await page.waitForTimeout(process.env.WAKTU_TUNGGU)
      if (items.pencipta[i].kota == 'MALANG' || items.pencipta[i].kota == 'JAMBI'){
        await page.keyboard.press('ArrowDown')
      }
      await page.waitForTimeout(process.env.WAKTU_TUNGGU)
      await page.keyboard.press("Enter")
      await page.keyboard.press("Tab")

      // console.log("- inputKota") --> SINGLE INPUT
      // const inputKotaPencipta = (await page.$x('//*[@id="alamat_pencipta"]/div[5]/div/input'))[0]
      // await inputKotaPencipta.type(items.pencipta[i].kota)
      // await page.keyboard.press('ArrowDown')
      // await page.keyboard.press("Enter")
      
      console.log("- inputKecamatan")
      const inputKecamatanPencipta = (await page.$x('//*[@id="alamat_pencipta"]/div[6]/div/select'))[0]
      inputKecamatanPencipta.click()
      await page.waitForTimeout(process.env.WAKTU_TUNGGU)
      const inputKecamatan = (await page.$x('/html/body/span/span/span[1]/input'))[0]
      await inputKecamatan.type(items.pencipta[i].kecamatan)
      await page.waitForTimeout(process.env.WAKTU_TUNGGU)
      await page.keyboard.press("Enter")

      console.log("- inputKodePos")
      const inputKodePos = (await page.$x('//*[@id="alamat_pencipta"]/div[7]/div/input'))[0]
      await inputKodePos.type(items.pencipta[i].kodepos)
      // await page.waitForTimeout(process.env.WAKTU_TUNGGU)

      //PILIHAN PEMEGANG HAK CIPTA
      console.log("- Pilihan Pemegang Hak Cipta")
      for (let index = 0; index < 2; index++) {
        await page.keyboard.press("Tab")
        await page.waitForTimeout(100)
      }
      await page.keyboard.press("Enter")
      await page.keyboard.type("tidak")
      await page.waitForTimeout(process.env.WAKTU_TUNGGU)
      await page.keyboard.press("Enter")
      
      // await page.waitForTimeout(process.env.WAKTU_TUNGGU)      

      console.log("- tblTambahPencipta")
      const tblTambahPencipta = (await page.$x('//*[@id="tambah"]'))[0]
      tblTambahPencipta.click()
      await page.waitForTimeout(2000)
    }

  }

  async function inputPemegang(page){
    console.log("Proses pemegang hak cipta")
    console.log("- Open Modal Pemegang")
    const tblAddPemegang = (await page.$x('//*[@id="createform"]/div[4]/div[3]/a'))[0]
    tblAddPemegang.click()
    await page.waitForSelector('[id="modal_template"]', {
      visible: true,
    }); 
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)

    //PILIHAN BADAN HUKUM
    console.log("- Pilih Badan Hukum")
    // INPUT PEMEGANG SETELAH LAMPIRAN
    // for (let index = 0; index < 14; index++) {
      
    // INPUT PEMEGANG SEBELUM LAMPIRAN
    for (let index = 0; index < 11; index++) {
      await page.keyboard.press("Tab")
      await page.waitForTimeout(100)
    }
    await page.keyboard.press("Enter")
    await page.keyboard.type("ya")
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)
    await page.keyboard.press("Enter")

    console.log("- NEXT PAGE")
    const tblNextPemegang = (await page.$x('//*[@id="next"]'))[0]
    tblNextPemegang.click()
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)

    console.log("- inputNamaPemegang")
    const inputNamaPemegang = (await page.$x('//*[@id="data_pemegang"]/div[2]/div/input'))[0]
    await inputNamaPemegang.type('Universitas Negeri Malang')

    console.log("- inputEmailPemegang")
    const inputEmailPemegang = (await page.$x('//*[@id="data_pemegang"]/div[3]/div/input'))[0]
    await inputEmailPemegang.type('sentrahki@um.ac.id')

    console.log("- inputTelpPemegang")
    const inputTelpPemegang = (await page.$x('//*[@id="data_pemegang"]/div[4]/div/input'))[0]
    await inputTelpPemegang.type('0341-551312')
    
    console.log("- NEXT PAGE")
    tblNextPemegang.click()
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)

    console.log("- inputAlamatPemegang")
    const inputAlamatPemegang = (await page.$x('//*[@id="alamat_pemegang"]/div[2]/div/textarea'))[0]
    await inputAlamatPemegang.type('Jalan Semarang No. 5')

    console.log("- inputProvinsiPemegang")
    const inputProvinsiPemegangBox = (await page.$x('//*[@id="alamat_pemegang"]/div[4]/div/select'))[0]
    inputProvinsiPemegangBox.click()
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)
    const inputProvinsiPemegang = (await page.$x('/html/body/span/span/span[1]/input'))[0]
    await inputProvinsiPemegang.type('Jawa Timur')
    await page.keyboard.press("Enter")
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)
    await page.keyboard.press("Enter")
    await page.keyboard.press("Tab")

    // --> KOTA DOUBLE INPUT
    console.log("- inputKota")
    const inputKotaCiptaan = (await page.$x('//*[@id="alamat_pemegang"]/div[5]/div/select'))[0]
    inputKotaCiptaan.click()
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)
    const inputKota1 = (await page.$x('/html/body/span/span/span[1]/input'))[0]
    await inputKota1.type('MALANG')
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)
    await page.keyboard.press("Enter")
    await page.keyboard.press("Tab")

    // --> KOTA SINGLE INPUT
    // console.log("- inputKotaPemegang")
    // const inputKotaPemegang = (await page.$x('//*[@id="alamat_pemegang"]/div[4]/div/input'))[0]
    // await inputKotaPemegang.type('MALANG')
    // await page.keyboard.press('ArrowDown')
    // await page.keyboard.press("Enter")
    // await page.waitForTimeout(process.env.WAKTU_TUNGGU)

    console.log("- inputKecamatanPemegang")
    const inputKecamatanPemegang = (await page.$x('//*[@id="alamat_pemegang"]/div[6]/div/select'))[0]
    inputKecamatanPemegang.click()
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)
    const inputKecamatanType = (await page.$x('/html/body/span/span/span[1]/input'))[0]
    await inputKecamatanType.type('LOWOKWARU')
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)
    await page.keyboard.press("Enter")

    console.log("- inputKodeposPemegang")
    const inputKodeposPemegang = (await page.$x('//*[@id="alamat_pemegang"]/div[7]/div/input'))[0]
    await inputKodeposPemegang.type('65145')

    console.log("- submitPemegang")
    const tblSubmitPemegang = (await page.$x('//*[@id="tambah"]'))[0]
    await tblSubmitPemegang.click()

  }

  async function inputLampiran(page){
    console.log("Proses lampiran")
    // Lampiran Fix    
    console.log("- input fileUMKM")
    const fileUMKM0 = (await page.$x('//*[@id="umkm"]/div/div[2]/singleupload/span[1]'))[0]
    const [fileUMKM] = await Promise.all([
      page.waitForFileChooser(),
      await fileUMKM0.click()
    ])
    await fileUMKM.accept([process.env.FILE_UMKM])

    console.log("- input fileAkta")
    const fileAkta0 = (await page.$x('//*[@id="createform"]/div[5]/div[2]/div/div[15]/div/div[2]/singleupload/span[1]'))[0]
    const [fileAkta] = await Promise.all([
      page.waitForFileChooser(),
      await fileAkta0.click()
    ])
    await fileAkta.accept([process.env.FILE_AKTA])

    console.log("- input fileNPWP")
    const fileNpwp0 = (await page.$x('//*[@id="createform"]/div[5]/div[2]/div/div[17]/div/div[2]/singleupload/span[1]'))[0]
    const [fileNPWP] = await Promise.all([
      page.waitForFileChooser(),
      await fileNpwp0.click()
    ])
    await fileNPWP.accept([process.env.FILE_NPWP])

    // // Lampiran Variable
    // const fileKtp = (await page.$x('//*[@id="createform"]/div[5]/div[2]/div/div[4]/div/div/singleupload/span[1]/input[1]'))[0]
    // await fileKtp.uploadFile(process.env.FILE_NPWP)
    
    // const filePernyataan = (await page.$x('//*[@id="createform"]/div[5]/div[2]/div/div[6]/div/div/singleupload/span[1]/input[1]'))[0]
    // await filePernyataan.uploadFile(process.env.FILE_NPWP)
    
    // const filePengalihan = (await page.$x('//*[@id="createform"]/div[5]/div[2]/div/div[8]/div/div/singleupload/span[1]/input[1]'))[0]
    // await filePengalihan.uploadFile(process.env.FILE_NPWP)
    
    // const fileCiptaan = (await page.$x('//*[@id="fileciptaan"]/multipleupload/span[1]/input[1]'))[0]
    // await fileCiptaan.uploadFile(process.env.FILE_NPWP)      
  }

  let nomorSertifikat
  let nomorAplikasi
  async function botGetSertifikat(items){
    if(!browser) {
      browser = await puppeteer.launch({
        headless: false,
        defaultViewport: false,
        userDataDir: "./tmp"
      });
    }
    
    const page = await browser.newPage();
    await page.goto('https://e-hakcipta.dgip.go.id/index.php/login');
    const url = await page.url();
    console.log('Akses URL: ',url)
    await page.waitForTimeout(2000)
    
    if(url == 'https://e-hakcipta.dgip.go.id/index.php/login'){
      // Login
      console.log("Prosess login")
      await page.type('[placeholder="Email"]', process.env.USER_ID)
      await page.type('[placeholder="Password"]', process.env.USER_KEY)
      page.click('[type="submit"]')
      
      await page.waitForNavigation({
        waitUntil: 'networkidle0',
      });
    }
    
    console.log('Mencari Judul: ', items.judul)
    await page.goto('https://e-hakcipta.dgip.go.id/index.php/list');
    await page.waitForTimeout(process.env.WAKTU_TUNGGU*2)
    await page.click('[id="btn-advance"]')
    await page.type('[name="title!like"]', items.judul)
    await page.waitForTimeout(process.env.WAKTU_TUNGGU)
    await page.click('[id="btn-search-advanced"]')
    await page.waitForTimeout(process.env.WAKTU_TUNGGU*2)
    const btnCiptaan = (await page.$x('//*[@id="sample_1"]/tbody/tr/td[2]/a'))[0]
    await btnCiptaan.click()
    console.log('...Membuka Ciptaan')
    await page.waitForNavigation({
      waitUntil: 'networkidle0',
    });
    const elementNoSertifikat = (await page.$x('//*[@id="detail"]/div[1]/div[2]/div/div[2]/div/div/span'))[0]
    nomorSertifikat = await elementNoSertifikat.evaluate(el => el.textContent)
    const elementNoAplikasi = (await page.$x('//*[@id="detail"]/div[1]/div[2]/div/div[1]/div/div/span'))[0]
    nomorAplikasi = await elementNoAplikasi.evaluate(el => el.textContent)
    
    const client = await page.target().createCDPSession()
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadPath 
    });
    const btnSertifikat = (await page.$x('//*[@id="detail"]/div[1]/div[1]/div[2]/a'))[0] || ''
    if (btnSertifikat==''){
      console.log('Sertifikat Belum Ada')
      return
    }
    await btnSertifikat.click()
    console.log('Mulai download sertifikat')
    console.log('Nomor Sertifikat: ', nomorSertifikat)
    // Run the checkFolder function every 1 second
    // interval = setInterval(checkFolder, 1000); // 1000 milliseconds = 1 second
  }

  let interval
  let fileFound = true
  async function checkFolder() {
    try {
      const files = fs.readdirSync(downloadPath);
  
      if (files.length > 0) {
        if(!files[0].toString().includes('crdownload')){
          fileFound = true
          console.log('Finish Download')
        }
      } else {
        console.log('...Menunggu proses download');
      }
    } catch (err) {
      console.error('Error reading the folder:', err);
    }
  }

  async function uploadFile(){
    const filesDownloaded = fs.readdirSync(downloadPath);
    const filePath = path.join('download/', filesDownloaded[0]);

    const drive = google.drive({ version: 'v3', auth: authClient2 });
    // Upload to Google Drive
    const response = await drive.files.create({
      requestBody: {
        name: nomorSertifikat,
        mimeType: 'application/pdf',
        parents: [folderID]
      },
      media: {
        mimeType: 'application/pdf',
        body: fs.createReadStream(filePath)
      },
      fields: 'id,webViewLink',
    });

    console.log('File uploaded');

    // Clean up: Delete the temporary file
    fs.unlinkSync(filePath); 
    const result = {
      id:  response.data.id,
      url: response.data.webViewLink,
    }
    return result
  }

  async function shareFile(fileID) {
    const drive = google.drive({ version: 'v3', auth: authClient2 });
  
    // Define the permission settings
    const permission = {
      type: 'anyone',
      role: 'reader',
    };
  
    try {
      // Set the file's sharing permissions
      await drive.permissions.create({
        fileId: fileID,
        requestBody: permission,
        fields: 'id',
      });

    } catch (error) {
      console.error('Error updating file sharing settings:', error.message);
    }
  }

  async function updateFirestore(URLSertifikat){
    console.log('Update Firestore')
    const testRef = db.collection('users').doc('tes');
    await ciptaanRef.update(
      {
        sertifikat: URLSertifikat,
        noSertifikat: nomorSertifikat,
        noAplikasi: nomorAplikasi,
        statusCiptaan: 'Selesai'
      }
      );

    console.log('Sertifikat sudah diinput, URL: ', URLSertifikat)   
  }

  // Function to introduce a delay using setTimeout
  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }