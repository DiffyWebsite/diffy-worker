const sharp = require('sharp');
const thumbnailWidth = 220;

const escapeSvgText = (text = '') => {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const wrapText = (text = '', maxLineLength = 90) => {
    if (!text.length) {
        return [''];
    }

    const result = [];
    text.split(/\r?\n/).forEach(line => {
        if (!line.length) {
            result.push('');
            return;
        }

        let remaining = line;
        while (remaining.length > maxLineLength) {
            result.push(remaining.slice(0, maxLineLength));
            remaining = remaining.slice(maxLineLength);
        }
        result.push(remaining);
    });

    return result;
};

module.exports = {
    generateImageThumbnail: async function (file, resultFile) {
        return sharp(file)
            .resize(thumbnailWidth)
            .toFile(resultFile);
    },

    crop: async function (filename, rect) {
        return sharp(filename)
            .extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
            .toFile(filename);
    },

    webp: async function (filename, filenameResult) {
        return sharp(filename)
            .webp({ quality: 95 })
            .toFile(filenameResult);
    },

    createErrorImage: async function (filename, errorText, width = 1024) {
        const sanitizedLines = wrapText((errorText || '').toString());
        const escapedText = sanitizedLines.map(line => escapeSvgText(line)).join("\n");

        return sharp({
            create: {
                width: width,
                height: 600,
                channels: 4,
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            }
        })
            .composite([{
                input: Buffer.from(`<svg width="${width}" height="600"><text x="10" y="20" font-family="Verdana" font-size="20" fill="black">${escapedText}</text></svg>`),
                top: 0,
                left: 0
            }])
            .png()
            .toFile(filename);
    },
};
