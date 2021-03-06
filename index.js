const fs = require('fs')
const path = require('path')

const fetch = require('node-fetch')
const chalk = require('chalk')
const cheerio = require('cheerio')
const phpunserialize = require('phpunserialize')
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const srcset = require('srcset');

const WP_API = `https://domainemalpaskookt.com/wp-json/wp/v2`
const RECIPE_DATA = require('./recipes.json')
const CATEGORIES = require('./categories.json')
const OUTPUT_PATH = path.join(process.cwd(), `./import`)
const HTML_PARSER = `./htmlParser.rb`

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

async function getPosts() {
  const posts = await getAllWp('posts')
  //const posts = [await getPostForId(3050)]
  const onlyRecipes = posts.filter(post => !post.categories.includes(36))

  return Promise.all(onlyRecipes.map(async post => {
    console.log(chalk.green(`Fetching ${post.slug}`))

    return {
      uid: post.slug,
      type: "recipe",
      publication_date: post.date,
      lang: "nl-nl",
      grouplang: "X6KP6hEAACMARrWF",
      title: await prismicify(`<h1>${post.title.rendered}</h1>`, post.slug),
      intro: await prismicify(post.excerpt.rendered, post.slug),
      additional_content: await cleanupContent(post.content.rendered, post.slug),
      categories: post.categories,
      tags: post.tags,
      // comments come later...
      // comments: await getCommentsForPost(post.id),
      meta_title: post._yoast_wpseo_title || post.title.rendered,
      meta_description: post._yoast_wpseo_metadesc,
      social_cards: [{
        social_card_image: {
          origin: {
            url: post.jetpack_featured_media_url || findImageInContent(post.content.rendered, post.slug),
          }
        },
        social_card_title: post._yoast_wpseo_title || post.title.rendered,
        social_card_description: post._yoast_wpseo_metadesc
      }],
      recipe_name: post.title.rendered,
      recipe_summary: await prismicify(post.excerpt.rendered, post.slug),
      recipe_image: {
        origin: {
          url: post.jetpack_featured_media_url || findImageInContent(post.content.rendered, post.slug),
        }
      },
    }
  }))
}

function findImageInContent(html, slug) {
  const $ = cheerio.load(html, { decodeEntities: true })
  if(!$('.wprm-recipe-container')[0]) {
    console.log(chalk.yellow(`Getting image from html: [${slug}]`))
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

async function cleanupContent(html, slug) {
  console.log(chalk.grey(`Starting cleanup: [${slug}]`))

  const $ = cheerio.load(html, { decodeEntities: true })
  if($('.wprm-recipe-container')[0]) {
    console.log(chalk.red(`Removing .wprm-recipe-container: [${slug}]`))
    $('.wprm-recipe-container').remove()
  }

  $('img').remove()
  $('figure').remove()
  $('strong').each((i, el) => $(el).replaceWith($(el).text()));

  // Yikes...
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
  
  console.log(chalk.grey(`Cleaned up: [${slug}]`))
  return await prismicify(res, slug);
}

async function prismicify(html, slug) {
  return await new Promise((resolve, reject) => {
    exec(
      `ruby ${HTML_PARSER} '${html}'`, (err, stdout) => {
        if(err) {
          reject(err)
        }

        console.log(chalk.grey(`Converted to Prismic HTML for: [${slug}]`))
        resolve(JSON.parse(stdout))
      }
    );
  });
}

async function getMetadata(which) {
  const meta = await getAllWp(which)
  
  return meta.map(m => ({
    id: m.id,
    name: m.name,
    slug: m.slug
  }))
}

function mapTags(ids, tags) {
  return ids.map(id => {
    return tags.find(tag => tag.id === id).name
  })
}

function mapCategories(ids, items) {
  const cats = ids.map(id => {
    return items.find(item => item.id === id).name
  })

  return cats.map(cat => {
    const category = CATEGORIES.find(category => category.label.toLowerCase() === cat.toLowerCase());
    if(category) {
      return {
        category: {
          id: category.id,
          wioUrl: `wio://documents/${category.id}`
        }
      }
    }
  })
}

function mapRecipedata(post) {
  const recipeExportData = RECIPE_DATA.channel.item.find(item => item.title === post.title[0].content.text)
  
  if(!recipeExportData) {
    return false
  }

  console.log(chalk.blue(`Mapping receipe data for: [${post.uid}]`))
  
  return {
    recipe_instructions: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_instructions'),
    recipe_ingredients: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_ingredients'),
    recipe_servings_amount: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_servings'),
    recipe_servings_type: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_servings_unit'),
    recipe_prep_time: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_prep_time'),
    recipe_cook_time: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_cook_time'),
  }
}

function enrichPostsWithMetadata(options) {
  return options.posts.map(post => ({
    ...post,
    tags: mapTags(post.tags, options.tags),
    categories: mapCategories(post.categories, options.categories),
    ...mapRecipedata(post)
  }))
}

function getMetaDatafromRecipe(data, which) {
  const item = data.find(d => d.meta_key === which)
  let result = item.meta_value

  if(which === 'wprm_instructions') {
    const instructions = phpunserialize(item.meta_value);
    if(instructions && instructions.length > 0) {
      result = mapInsructions(phpunserialize(item.meta_value))
    }
    else {
      result = false
    }
  }
  
  if(which === 'wprm_ingredients') {
    const ingredients = phpunserialize(item.meta_value);

    if(ingredients && ingredients.length > 0) {
      result = mapIngredients(phpunserialize(item.meta_value))
    }
    else {
      result = false
    }
  }

   return result
}

function mapInsructions(instructionsGroups) {
  const result = [];
  
  instructionsGroups.forEach(group => {
    if(group.name) {
      result.push({
        instructions_group_title: group.name
      })
    }
  
    group.instructions.forEach(instruction => {
      result.push({
        instruction: instruction.text.replace(/<p>(.*?)<\/p>/g,'$1')
      })
    })
  })

  return result;
}

function mapIngredients(ingredientsGroups) {
  const result = [];
  
  ingredientsGroups.forEach(group => {
    if(group.name) {
      result.push({
        ingredient_group_title: group.name
      })
    }
  
    group.ingredients.forEach(ingredient => {
      result.push({
        ingredient_amount: ingredient.amount,
        ingredient_unit: ingredient.unit,
        ingredient_name: ingredient.name
      })
    })
  })

  return result;
}

function writePost(post) {
  return new Promise((resolve, reject) => {
    fs.writeFile(`${OUTPUT_PATH}/new_${uuidv4()}_nl-nl.json`, JSON.stringify(post, null, 2), (err) => {
      if(err) {
        reject(err);
      }
      resolve();
    });
  });
}

// currently unused
// async function getPostForId(id) {
//   return await fetch(`${WP_API}/posts/${id}`).then(response => {
//     if (response.ok) {
//       return response.json()
//     }
//     throw new Error(`Fetching post ${id} failed with code ${response.status}`)
//   })
// }

// Currently unused.
// async function getCommentsForPost(id) {
//   return await fetch(`${WP_API}/comments?post=${id}`).then(response => {
//     if (response.ok) {
//       return response.json()
//     }
//     return false
//   })  
// }

(async () => {
  const posts = enrichPostsWithMetadata({
    posts: await getPosts(),
    tags: await getMetadata('tags'),
    categories: await getMetadata('categories')
  })

  Promise.all(posts.map(writePost))
})()
