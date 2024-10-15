const express = require('express');
const fs = require('fs');
const multer = require('multer');
const rimraf = require('rimraf');
const archiver = require('archiver');
const { PDFDocumentFactory, PDFName, PDFRawStream } = require('pdf-lib');
const { PNG } = require('pngjs');
const pako = require('pako');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Handle file upload and conversion
app.post('/convert', upload.single('pdf'), async (req, res) => {
  try {
    const pdfPath = req.file.path;
    const pdfDoc = PDFDocumentFactory.load(fs.readFileSync(pdfPath));

    const imagesInDoc = [];
    let objectIdx = 0;

    // Find all image objects in the PDF
    pdfDoc.index.index.forEach((pdfObject, ref) => {
      objectIdx += 1;

      if (!(pdfObject instanceof PDFRawStream)) return;

      const { lookupMaybe } = pdfDoc.index;
      const { dictionary: dict } = pdfObject;

      const smaskRef = dict.getMaybe('SMask');
      const colorSpace = lookupMaybe(dict.getMaybe('ColorSpace'));
      const subtype = lookupMaybe(dict.getMaybe('Subtype'));
      const width = lookupMaybe(dict.getMaybe('Width'));
      const height = lookupMaybe(dict.getMaybe('Height'));
      const name = lookupMaybe(dict.getMaybe('Name'));
      const bitsPerComponent = lookupMaybe(dict.getMaybe('BitsPerComponent'));
      const filter = lookupMaybe(dict.getMaybe('Filter'));

      if (subtype === PDFName.from('Image')) {
        imagesInDoc.push({
          ref,
          smaskRef,
          colorSpace,
          name: name ? name.key : `Object${objectIdx}`,
          width: width.number,
          height: height.number,
          bitsPerComponent: bitsPerComponent.number,
          data: pdfObject.content,
          type: filter === PDFName.from('DCTDecode') ? 'jpg' : 'png',
        });
      }
    });

    // Save PNG images
    const savePng = async (image) => {
      const colorPixels = pako.inflate(image.data);
      const png = new PNG({
        width: image.width,
        height: image.height,
        colorType: 6, // RGB + Alpha
      });

      let pixelIdx = 0;
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          const idx = (image.width * y + x) * 4; // 4 for RGBA
          
          // RGB Channels
          png.data[idx] = colorPixels[pixelIdx++];      // R
          png.data[idx + 1] = colorPixels[pixelIdx++];  // G
          png.data[idx + 2] = colorPixels[pixelIdx++];  // B
          
          // Alpha Channel (assuming it's set to fully opaque by default)
          png.data[idx + 3] = 255; // Fully opaque; replace with the actual alpha if available
        }
      }

      return new Promise((resolve, reject) => {
        const buffer = [];
        png.pack()
          .on('data', data => buffer.push(...data))
          .on('end', () => resolve(Buffer.from(buffer)))
          .on('error', err => reject(err));
      });
    };

    rimraf('./images/*', async (err) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Internal Server Error');
      }

      const imageFiles = [];

      for (const img of imagesInDoc) {
        if (img.type === 'png') {
          const imageData = await savePng(img);
          const fileName = `out${imageFiles.length + 1}.png`;
          fs.writeFileSync(`./images/${fileName}`, imageData);
          imageFiles.push(fileName);
        } else {
          // Handle JPG images directly
          fs.writeFileSync(`./images/out${imageFiles.length + 1}.jpg`, img.data);
          imageFiles.push(`out${imageFiles.length + 1}.jpg`);
        }
      }

      // Create a zip file and send it as a response
      const zipFilePath = path.join(__dirname, 'images.zip');
      const zipStream = fs.createWriteStream(zipFilePath);
      const archive = archiver('zip', {
        zlib: { level: 9 } // Set the compression level
      });

      zipStream.on('close', () => {
        // Delete the extracted images after zipping
        rimraf('./images/*', (err) => {
          if (err) {
            console.error('Error deleting extracted images:', err);
          }
        });

        // Send the zip file as a response
        res.download(zipFilePath, 'images.zip', (err) => {
          if (err) {
            console.error('Error sending zip file:', err);
          }
          // Delete the zip file after sending
          fs.unlink(zipFilePath, (err) => {
            if (err) {
              console.error('Error deleting zip file:', err);
            }
          });
        });
      });

      // Pipe the archive to the output file
      archive.pipe(zipStream);

      // Append the image files to the zip archive
      imageFiles.forEach(file => {
        archive.file(`./images/${file}`, { name: file });
      });

      // Finalize the archive (this is important)
      archive.finalize();

      fs.unlink(pdfPath, (err) => {
        if (err) {
          console.error('Error deleting PDF file:', err);
        } else {
          console.log('PDF file deleted successfully');
        }
      });
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(3000, () => {
  console.log('Server is running on port 3000');
});
