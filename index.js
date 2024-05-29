const express = require('express');
const fs = require('fs');
const multer = require('multer');
const rimraf = require('rimraf');
const { PDFDocumentFactory, PDFName, PDFRawStream } = require('pdf-lib');
const { PNG } = require('pngjs');
const pako = require('pako');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Serve the HTML page
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Handle file upload and conversion
app.post('/convert', upload.single('pdf'), async (req, res) => {
  try {
    const pdfPath = req.file.path;
    const pdfDoc = PDFDocumentFactory.load(fs.readFileSync(pdfPath));

    // Define some variables we'll use in a moment
    const imagesInDoc = [];
    let objectIdx = 0;

    // (1) Find all the image objects in the PDF
    // (2) Extract useful info from them
    // (3) Push this info object to `imageInDoc` array
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

    // Find and mark SMasks as alpha layers
    imagesInDoc.forEach(image => {
      if (image.type === 'png' && image.smaskRef) {
        const smaskImg = imagesInDoc.find(({ ref }) => ref === image.smaskRef);
        smaskImg.isAlphaLayer = true;
        image.alphaLayer = image;
      }
    });

    const savePng = image =>
      new Promise((resolve, reject) => {
        const isGrayscale = image.colorSpace === PDFName.from('DeviceGray');
        const colorPixels = pako.inflate(image.data);
        const alphaPixels = image.alphaLayer
          ? pako.inflate(image.alphaLayer.data)
          : undefined;

        // prettier-ignore
        const colorType =
          isGrayscale && alphaPixels ? PngColorTypes.GrayscaleAlpha
          : !isGrayscale && alphaPixels ? PngColorTypes.RgbAlpha
          : isGrayscale ? PngColorTypes.Grayscale
          : PngColorTypes.Rgb;

        const colorByteSize = 1;
        const width = image.width * colorByteSize;
        const height = image.height * colorByteSize;
        const inputHasAlpha = [
          PngColorTypes.RgbAlpha,
          PngColorTypes.GrayscaleAlpha,
        ].includes(colorType);

        const png = new PNG({
          width,
          height,
          colorType,
          inputColorType: colorType,
          inputHasAlpha,
        });

        const componentsPerPixel = ComponentsPerPixelOfColorType[colorType];
        png.data = new Uint8Array(width * height * componentsPerPixel);

        let colorPixelIdx = 0;
        let pixelIdx = 0;

        // prettier-ignore
        while (pixelIdx < png.data.length) {
          if (colorType === PngColorTypes.Rgb) {
            png.data[pixelIdx++] = colorPixels[colorPixelIdx++];
            png.data[pixelIdx++] = colorPixels[colorPixelIdx++];
            png.data[pixelIdx++] = colorPixels[colorPixelIdx++];
          }
          else if (colorType === PngColorTypes.RgbAlpha) {
            png.data[pixelIdx++] = colorPixels[colorPixelIdx++];
            png.data[pixelIdx++] = colorPixels[colorPixelIdx++];
            png.data[pixelIdx++] = colorPixels[colorPixelIdx++];
            png.data[pixelIdx++] = alphaPixels[colorPixelIdx - 1];
          }
          else if (colorType === PngColorTypes.Grayscale) {
            const bit = readBitAtOffsetOfArray(colorPixels, colorPixelIdx++) === 0
              ? 0x00
              : 0xff;
            png.data[png.data.length - (pixelIdx++)] = bit;
          }
          else if (colorType === PngColorTypes.GrayscaleAlpha) {
            const bit = readBitAtOffsetOfArray(colorPixels, colorPixelIdx++) === 0
              ? 0x00
              : 0xff;
            png.data[png.data.length - (pixelIdx++)] = bit;
            png.data[png.data.length - (pixelIdx++)] = alphaPixels[colorPixelIdx - 1];
          }
          else {
            throw new Error(`Unknown colorType=${colorType}`);
          }
        }

        const buffer = [];
        png
          .pack()
          .on('data', data => buffer.push(...data))
          .on('end', () => resolve(Buffer.from(buffer)))
          .on('error', err => reject(err));
      });

    rimraf('./images/*.{jpg,png}', async err => {
      if (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
        return;
      }

      const imageFiles = [];

      for (const img of imagesInDoc) {
        if (!img.isAlphaLayer) {
          const imageData = img.type === 'jpg' ? img.data : await savePng(img);
          const fileName = `out${imageFiles.length + 1}.png`;
          fs.writeFileSync(`./images/${fileName}`, imageData);
          imageFiles.push(fileName);
        }
      }

      console.log('Images written to ./images');
      res.json(imageFiles);
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(3000, () => {
  console.log('Server is running on port 3000');
});
