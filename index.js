const fetch = require('node-fetch')
const chalk = require('chalk')
const cheerio = require('cheerio')
const phpunserialize = require('phpunserialize')
const WP_API = `https://domainemalpaskookt.com/wp-json/wp/v2`
const recipeData = require('./recipes.json')
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const srcset = require('srcset');

const fs = require('fs')
const path = require('path')

const OUTPUT_PATH = path.join(process.cwd(), `./import`)
const HTML_PARSER = `./htmlParser.rb`;

async function getAllWp(resource, queryParams) {
  let page = 1
  const baseQuery = `${WP_API}/${resource}?per_page=100&${queryParams}`

  const totalPages = await fetch(baseQuery, { mode: 'headers' })
    .then(response => response.headers.get('x-wp-totalpages'))
  
  const getPage = async page => {
    console.log(chalk.gray(`Fetching ${page > 1 ? `page ${page} of ` : ``}${resource}...`))
  
    return await fetch(`${baseQuery}&page=${page}`).then(response => {
      if (!response.ok) {
        throw new Error(`Fetching ${resource} failed with code ${response.status}`)
      }
      return response.json()
    })
  }

  const resources = await getPage(page)

  while (page < totalPages) {
    page++
    Array.prototype.push.apply(resources, await getPage(page))
  }

  return resources
}

async function getCommentsForPost(id) {
  return await fetch(`${WP_API}/comments?post=${id}`).then(response => {
    if (response.ok) {
      return response.json()
    }
    else {
      return false
    }
  })  
}

async function getPosts() {
  const posts = await getAllWp('posts')
  return Promise.all(posts.map(async post => {
    console.log(chalk.green(`Fetching ${post.slug}`))

    return {
      id: post.id,
      date: post.date,
      slug: post.slug,
      title: post.title.rendered,
      content: await cleanupContent(post.content.rendered, post.slug, post.id),
      excerpt: post.excerpt.rendered,
      categories: post.categories,
      tags: post.tags,
      image: post.jetpack_featured_media_url || findImageInContent(post.content.rendered, post.slug, post.id),
      comments: await getCommentsForPost(post.id),
      og: {
        title: post._yoast_wpseo_title || post.title.rendered,
        desc: post._yoast_wpseo_metadesc
      }
    }
  }))
}

function findImageInContent(html, slug, id) {
  const $ = cheerio.load(html, { decodeEntities: true })
  if(!$('.wprm-recipe-container')[0]) {
    console.log(chalk.yellow(`Getting image from html: ${id} [${slug}]`))
    const srcFancy = $('img').attr('srcset');
    let src = '';

    if(srcFancy) {
      const parsedSrcset = srcset.parse(srcFancy)
      src = parsedSrcset[parsedSrcset.length - 1].url
    }
    else {
      src = $('img').attr('src')
    }

    return src 
  }
}

async function cleanupContent(html, slug, id) {
  console.log(chalk.grey(`Starting cleanup: ${id} [${slug}]`))

  const $ = cheerio.load(html, { decodeEntities: true })
  if($('.wprm-recipe-container')[0]){
    console.log(chalk.red(`Removing .wprm-recipe-container: ${id} [${slug}]`))
    $('.wprm-recipe-container').remove()
  }

  $('img').remove()
  $('figure').remove()

  $('strong').each((i, el) => {
    return $(el).replaceWith($(el).text());
  });

  const res = $.html('body')
                .replace(/<body>|<\/body>/g, '')
                .replace(/\r?\n|\r/g, '')
                .replace(/<p><\/p>/g, '')
                .replace(/<p> <\/p>/g, '')
                .replace(/<p>&nbsp;<\/p>/g, '')
                .replace(/&#x2013;/g, '<br />-')
                .replace(/;\)/g, ':)')
                .replace(/<!--more-->/g, '')
                .replace(/<p><!--more--><\/p>/g, '')
                .replace(/<!-- wp:more -->|<!-- \/wp:more -->/g, '')
                .replace(/<!-- wp:paragraph -->|<!-- \/wp:paragraph -->/g, '')
                .replace(/rel="noopener noreferrer"/g, 'rel="noopener"')
  
  console.log(chalk.grey(`Cleaned up: ${id} [${slug}]`))

  return await new Promise((resolve, reject) => {
    exec(
      `ruby ${HTML_PARSER} '${res}'`, (err, stdout) => {
        if(err) {
          reject(err)
        }

        console.log(chalk.grey(`Created prismic HTML for: ${id} [${slug}]`))
        resolve(JSON.parse(stdout))
      }
    );
  });
}

async function getMetadata(which) {
  const meta = await getAllWp(which)
  
  return meta.map(m => {
    return {
      id: m.id,
      name: m.name,
      slug: m.slug
    }
  })
}

function mapMetadata(ids, items) {
  return ids.map(id => {
    const item = items.find(item => item.id === id)
    return {
      id: item.id,
      name: item.name,
      slug: item.slug
    }
  })
}

function mapRecipeData(post) {
  const recipeExportData = recipeData.channel.item.find(item => item.title === post.title)

  if(!recipeExportData || post.id === 1846) {
    return false
  }

  console.log(chalk.blue(`Mapping receipe data for: ${post.id} [${post.slug}]`))
  const instructions = getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_instructions');
  const ingredients = getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_ingredients');

  return {
    instructions: (instructions && instructions.length > 0) ? instructions[0].instructions : false,
    ingredients: (ingredients && ingredients.length > 0) ? ingredients[0].ingredients : false,
    servings: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_servings'),
    servingsUnit: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_servings_unit'),
    prepTime: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_prep_time'),
    cookTime: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_cook_time'),
  }
}

function enrichPostsWithMetadata(options) {
  return options.posts.map(post => {
    return {
      ...post,
      tags: mapMetadata(post.tags, options.tags),
      categories: mapMetadata(post.categories, options.categories),
      recipe: mapRecipeData(post)
    }
  })
}

function getMetaDatafromRecipe(data, which) {
  const item = data.find(d => d.meta_key === which)
  let result = item.meta_value

  if(which === 'wprm_instructions') {
    result = phpunserialize(item.meta_value)[0].instructions.map(instruction => {
      return {
        text: instruction.text
      }
    })
  }
  
  if(which === 'wprm_ingredients') {
    result = phpunserialize(item.meta_value)[0].ingredients.map(ingredient => {
      return {
        amount: ingredient.amount,
        unit: ingredient.unit,
        name: ingredient.name,
      }
    })
  }

   return result
}

function writePost(post) {
  return new Promise((resolve, reject) => {
    fs.writeFile(`${OUTPUT_PATH}/new_${uuidv4()}_nl-NL.json`, JSON.stringify(post, null, 2), (err) => {
      if(err) {
        reject(err);
      }
      resolve();
    });
  });
}

async function getPostForId(id) {
  return await fetch(`${WP_API}/posts/${id}`).then(response => {
    if (response.ok) {
      return response.json()
    }
    else {
      throw new Error(`Fetching post ${id} failed with code ${response.status}`)
    }
  })
}

(async () => {
  const posts = enrichPostsWithMetadata({
    posts: await getPosts(),
    tags: await getMetadata('tags'),
    categories: await getMetadata('categories')
  })

  return Promise.all(posts.map(writePost));
})()

// const allInstructions = recipeData.channel.item.map(recipe => {
//   console.log(`parsing ${recipe.title}`)
//   return {
//     title: recipe.title,
//     instructionsRaw: recipe.postmeta.find(d => d.meta_key === 'wprm_instructions').meta_value,
//     instructionsParsed: phpunserialize(recipe.postmeta.find(d => d.meta_key === 'wprm_instructions').meta_value)
//   }
// })

// console.log(allInstructions)