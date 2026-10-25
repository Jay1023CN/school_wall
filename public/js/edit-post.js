
document.addEventListener('DOMContentLoaded', function() {

  if (!isLoggedIn()) {
    window.location.href = '/login';
    return;
  }

  updateNavbar();

  var postId = window.location.pathname.split('/').pop();
  if (!postId || isNaN(postId)) {
    showToast('帖子不存在', 'error');
    window.location.href = '/';
    return;
  }

  var uploadedImages = [];
  var MAX_IMAGES = 9;
  var MAX_FILE_SIZE = 5 * 1024 * 1024;
  var ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  var isSubmitting = false;
  var originalPostData = null;

  var uploadArea = document.querySelector('.image-upload-area');
  var fileInput = document.getElementById('imageInput');
  var imagePreviewList = document.getElementById('imagePreviewList');
  var postForm = document.getElementById('editPostForm');
  var charCount = document.getElementById('charCount');
  var contentTextarea = document.getElementById('postContent');
  var categorySelect = document.getElementById('postCategory');
  var titleInput = document.getElementById('postTitle');
  var anonymousToggle = document.getElementById('anonymousToggle');
  var submitBtn = document.getElementById('submitBtn');
  var editorSurface = document.getElementById('postContentEditor');
  var postEditor = window.CampusWallPostEditor && window.CampusWallPostEditor.create({
    storage: contentTextarea,
    surface: editorSurface,
    picker: document.getElementById('emojiPicker'),
    trigger: document.getElementById('editEmojiTrigger'),
    emojis: window.CampusWallPostEmojis || [],
    maxLength: 5000,
    onChange: function(value, length) {
      if (!charCount) return;
      charCount.textContent = String(length);
      charCount.style.color = value.length > 2000 ? '#EF4444' : '';
    }
  });

  window.showEmojiPicker = function() { if (postEditor) postEditor.showPicker(); };
  window.insertEmoji = function(emoji) { if (postEditor) postEditor.insertEmoji(emoji); };
  window.insertFormat = function(type) { if (postEditor) postEditor.format(type); };

  loadPostData();

  async function loadPostData() {
    try {
      var data = await authFetch('/api/posts/' + postId + '/edit');
      if (data.code === 200) {
        originalPostData = data.data;
        populateForm(originalPostData);
        try {
          var settings = await (window.CampusWallThemeSettings ? window.CampusWallThemeSettings() : authFetch('/api/site-info'));
          var allowed = !!(settings && (settings.anon_post || (settings.data && settings.data.anon_post)));
          if (!allowed && !originalPostData.is_anonymous && anonymousToggle) {
            anonymousToggle.checked = false;
            anonymousToggle.closest('.form-group').style.display = 'none';
          }
        } catch (_) {
        }
      } else if (data.code === 403) {
        showToast('无权编辑此帖子', 'error');
        window.location.href = '/post/' + postId;
      } else {
        showToast(data.message || '加载失败', 'error');
        window.location.href = '/';
      }
    } catch (err) {
      console.error('加载帖子数据失败:', err);
      showToast('网络错误，请稍后重试', 'error');
      window.location.href = '/';
    }
  }

  function populateForm(post) {
    if (titleInput) titleInput.value = post.title || '';
    if (postEditor) postEditor.setValue(post.content || '');
    else if (contentTextarea) contentTextarea.value = post.content || '';
    if (categorySelect) categorySelect.value = post.category || '日常';
    if (anonymousToggle) anonymousToggle.checked = post.is_anonymous;

    if (charCount && contentTextarea) {
      charCount.textContent = postEditor ? postEditor.getTextLength() : contentTextarea.value.length;
    }

    if (post.images && post.images.length > 0) {
      uploadedImages = post.images;
      renderImagePreviews();
    }

    var pollGroup = document.getElementById('pollGroup');
    var pollContainer = document.getElementById('pollOptionsContainer');
    if (pollGroup && pollContainer) {
      if (post.poll_type) {
        pollGroup.style.display = 'block';
        pollContainer.innerHTML = '';
        if (post.poll_options && post.poll_options.length > 0) {
          post.poll_options.forEach(function(opt) {
            addEditPollOptionRow(opt.text || opt.option_text || '');
          });
        } else {
          addEditPollOptionRow('');
          addEditPollOptionRow('');
        }
        var pollMultiple = document.getElementById('pollMultiple');
        if (pollMultiple) pollMultiple.checked = (post.poll_type === 'multiple');
        if (categorySelect) categorySelect.value = '投票';
      } else {
        pollGroup.style.display = 'none';
      }
    }

    if (categorySelect && !categorySelect.dataset.bound) {
      categorySelect.dataset.bound = '1';
      categorySelect.addEventListener('change', function() {
        if (pollGroup) pollGroup.style.display = this.value === '投票' ? 'block' : 'none';
      });
    }
  }

  window.addEditPollOption = function() { addEditPollOptionRow(''); };
  function addEditPollOptionRow(value) {
    var container = document.getElementById('pollOptionsContainer');
    if (!container) return;
    var num = container.querySelectorAll('.poll-option-input').length + 1;
    var div = document.createElement('div');
    div.className = 'poll-option-row';
    div.innerHTML = '<input type="text" class="form-input poll-option-input" placeholder="选项 ' + num + '" maxlength="100" value="' + (value ? escapeHtml(value) : '') + '"><button type="button" class="btn-del-option" onclick="this.parentElement.remove()">✕</button>';
    container.appendChild(div);
  }

  if (uploadArea && fileInput) {

    uploadArea.addEventListener('click', function(e) {
      if (e.target.closest('.preview-delete-btn')) return;
      fileInput.click();
    });

    fileInput.addEventListener('change', function() {
      if (this.files && this.files.length > 0) {
        handleFileSelect(this.files);
        this.value = '';
      }
    });

    uploadArea.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.stopPropagation();
      uploadArea.classList.add('drag-over');
    });

    uploadArea.addEventListener('dragleave', function(e) {
      e.preventDefault();
      e.stopPropagation();
      uploadArea.classList.remove('drag-over');
    });

    uploadArea.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      uploadArea.classList.remove('drag-over');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleFileSelect(e.dataTransfer.files);
      }
    });
  }

  function handleFileSelect(files) {
    for (var i = 0; i < files.length; i++) {
      var file = files[i];

      if (uploadedImages.length >= MAX_IMAGES) {
        showToast('最多只能上传' + MAX_IMAGES + '张图片', 'error');
        break;
      }

      if (file.size > MAX_FILE_SIZE) {
        showToast('图片大小不能超过5MB', 'error');
        continue;
      }

      if (ALLOWED_TYPES.indexOf(file.type) === -1) {
        showToast('仅支持 JPG、PNG、GIF、WebP 格式', 'error');
        continue;
      }

      var reader = new FileReader();
      reader.onload = (function(file, index) {
        return function(e) {
          uploadedImages.push(e.target.result);
          renderImagePreviews();
        };
      })(file, i);
      reader.readAsDataURL(file);
    }
  }

  function renderImagePreviews() {
    if (!imagePreviewList) return;
    
    var html = '';
    for (var i = 0; i < uploadedImages.length; i++) {
      html += '<div class="image-preview-item" data-index="' + i + '">' +
                '<img src="' + escapeHtml(uploadedImages[i]) + '" alt="预览">' +
                '<button type="button" class="preview-delete-btn" onclick="deleteImage(' + i + ')">✕</button>' +
              '</div>';
    }
    imagePreviewList.innerHTML = html;

    if (uploadArea) {
      var placeholder = uploadArea.querySelector('.upload-placeholder');
      if (placeholder) {
        placeholder.textContent = uploadedImages.length >= MAX_IMAGES ? '已达上限' : '继续添加';
      }
    }
  }

  window.deleteImage = function(index) {
    uploadedImages.splice(index, 1);
    renderImagePreviews();
  };

  if (editorSurface) {
    function autoResizeEdit() {
      editorSurface.style.height = 'auto';
      editorSurface.style.height = Math.max(editorSurface.scrollHeight, 220) + 'px';
    }
    editorSurface.addEventListener('input', autoResizeEdit);
    setTimeout(autoResizeEdit, 200);
    setTimeout(autoResizeEdit, 600);
    setTimeout(autoResizeEdit, 1500);
  }

  if (postForm) {
    postForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      
      if (isSubmitting) return;
      
      var content = postEditor ? postEditor.getValue().trim() : (contentTextarea ? contentTextarea.value.trim() : '');
      var title = titleInput ? titleInput.value.trim() : '';
      
      if (!title) {
        showToast('标题不能为空', 'error');
        titleInput.focus();
        return;
      }

      if (title.length > 100) {
        showToast('标题不能超过100字符', 'error');
        return;
      }

      if (content.length > 5000) {
        showToast('内容不能超过5000字符', 'error');
        return;
      }
      
      isSubmitting = true;
      submitBtn.disabled = true;
      submitBtn.textContent = '保存中...';
      
      try {
        var finalImages = [];
        
        var newImages = [];
        for (var i = 0; i < uploadedImages.length; i++) {
          if (uploadedImages[i].startsWith('data:')) {
            newImages.push(uploadedImages[i]);
          } else {
            finalImages.push(uploadedImages[i]);
          }
        }
        
        if (newImages.length > 0) {
          var uploadPromises = newImages.map(function(base64) {
            return uploadBase64Image(base64);
          });
          var uploadedUrls = await Promise.all(uploadPromises);
          finalImages = finalImages.concat(uploadedUrls.filter(Boolean));
        }
        
        var submitData = {
          title: title,
          content: content,
          category: categorySelect ? categorySelect.value : '日常',
          is_anonymous: anonymousToggle ? anonymousToggle.checked : false
        };

        if (finalImages.length > 0) submitData.images = finalImages;

        if (submitData.category === '投票') {
          var pollInputs = document.querySelectorAll('.poll-option-input');
          var pollOpts = [];
          pollInputs.forEach(function(inp) {
            var v = inp.value.trim();
            if (v) pollOpts.push(v);
          });
          if (pollOpts.length >= 2) {
            submitData.pollOptions = pollOpts;
          } else {
            showToast('投票选项至少需要2项', 'error');
            isSubmitting = false;
            submitBtn.disabled = false;
            submitBtn.textContent = '保存修改';
            return;
          }
          var pollMultiple = document.getElementById('pollMultiple');
          submitData.pollType = (pollMultiple && pollMultiple.checked) ? 'multiple' : 'single';
        }
        
        var data = await authFetch('/api/posts/' + postId, {
          method: 'PUT',
          body: JSON.stringify(submitData)
        });
        
        if (data.code === 200) {
          showToast(data.message);
          setTimeout(function() {
            window.location.href = '/post/' + postId;
          }, 1500);
        } else {
          showToast(data.message || '保存失败', 'error');
          isSubmitting = false;
          submitBtn.disabled = false;
          submitBtn.textContent = '保存修改';
        }
      } catch (err) {
        console.error('保存失败:', err);
        showToast('网络错误，请稍后重试', 'error');
        isSubmitting = false;
        submitBtn.disabled = false;
        submitBtn.textContent = '保存修改';
      }
    });
  }

  async function uploadBase64Image(base64) {
    try {
      var response = await fetch(base64);
      var blob = await response.blob();
      var file = new File([blob], 'image.jpg', { type: blob.type });
      
      var formData = new FormData();
      formData.append('images', file);
      
      var data = await authFetch('/api/upload/post-images', {
        method: 'POST',
        body: formData
      });
      
      if (data.code === 200 && data.data && data.data.images && data.data.images.length > 0) {
        return data.data.images[0];
      }
      return null;
    } catch (err) {
      console.error('图片上传失败:', err);
      return null;
    }
  }

});
